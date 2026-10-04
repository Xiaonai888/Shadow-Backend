import { supabase } from '../config/supabase.js'

const REPLY_ID_PAGE_SIZE = 1000
const REPLY_BATCH_QUEUE_LIMIT = 200
const replyBatchQueues = new Map()

function clean(value) {
  return String(value || '').trim()
}

function batchKey({
  storyId,
  episodeId,
  page,
  limit,
}) {
  return [
    clean(storyId),
    clean(episodeId) || 'story',
    Math.max(1, Number(page || 1)),
    Math.max(1, Number(limit || 5)),
  ].join(':')
}

async function loadSingleReplyPage({
  parentId,
  storyId,
  episodeId = null,
  page = 1,
  limit = 5,
}) {
  const safePage = Math.max(
    1,
    Number(page || 1)
  )
  const safeLimit = Math.max(
    1,
    Number(limit || 5)
  )
  const from =
    (safePage - 1) * safeLimit
  const to =
    from + safeLimit - 1

  let query = supabase
    .from('comments')
    .select(
      '*, user:users(id, name, username, avatar_url, role)',
      { count: 'exact' }
    )
    .eq('story_id', storyId)
    .eq('is_hidden', false)
    .is('deleted_at', null)
    .eq('parent_id', parentId)
    .order(
      'created_at',
      { ascending: true }
    )
    .range(from, to)

  if (episodeId) {
    query = query.eq(
      'episode_id',
      episodeId
    )
  } else {
    query = query.is(
      'episode_id',
      null
    )
  }

  const {
    data,
    error,
    count,
  } = await query

  if (error) throw error

  const rows = data || []
  const total = Number(count || 0)

  return {
    rows,
    total,
    page: safePage,
    limit: safeLimit,
    hasMore:
      safePage * safeLimit < total,
  }
}

async function loadReplyIdRows({
  parentIds,
  storyId,
  episodeId,
}) {
  const rows = []
  let offset = 0

  while (true) {
    let query = supabase
      .from('comments')
      .select(
        'id,parent_id,created_at'
      )
      .eq('story_id', storyId)
      .eq('is_hidden', false)
      .is('deleted_at', null)
      .in('parent_id', parentIds)
      .order(
        'parent_id',
        { ascending: true }
      )
      .order(
        'created_at',
        { ascending: true }
      )
      .order(
        'id',
        { ascending: true }
      )
      .range(
        offset,
        offset +
          REPLY_ID_PAGE_SIZE -
          1
      )

    if (episodeId) {
      query = query.eq(
        'episode_id',
        episodeId
      )
    } else {
      query = query.is(
        'episode_id',
        null
      )
    }

    const {
      data,
      error,
    } = await query

    if (error) throw error

    const pageRows =
      Array.isArray(data)
        ? data
        : []

    rows.push(...pageRows)

    if (
      pageRows.length <
      REPLY_ID_PAGE_SIZE
    ) {
      break
    }

    offset +=
      REPLY_ID_PAGE_SIZE
  }

  return rows
}

async function loadReplyDetails(ids) {
  if (!ids.length) {
    return new Map()
  }

  const { data, error } =
    await supabase
      .from('comments')
      .select(
        '*, user:users(id, name, username, avatar_url, role)'
      )
      .in('id', ids)

  if (error) throw error

  return new Map(
    (data || []).map(
      (row) => [
        String(row.id),
        row,
      ]
    )
  )
}

async function loadBatch({
  entries,
  storyId,
  episodeId,
  page,
  limit,
}) {
  const parentIds = [
    ...new Set(
      entries
        .map((entry) =>
          clean(entry.parentId)
        )
        .filter(Boolean)
    ),
  ]

  const idRows =
    await loadReplyIdRows({
      parentIds,
      storyId,
      episodeId,
    })

  const idsByParent = new Map(
    parentIds.map(
      (parentId) => [
        parentId,
        [],
      ]
    )
  )

  for (const row of idRows) {
    const parentId =
      clean(row.parent_id)
    const id =
      clean(row.id)

    if (
      !parentId ||
      !id ||
      !idsByParent.has(parentId)
    ) {
      continue
    }

    idsByParent
      .get(parentId)
      .push(id)
  }

  const from =
    (page - 1) * limit
  const to =
    from + limit
  const selectedIds = [
    ...new Set(
      parentIds.flatMap(
        (parentId) =>
          (
            idsByParent.get(
              parentId
            ) || []
          ).slice(from, to)
      )
    ),
  ]

  const detailMap =
    await loadReplyDetails(
      selectedIds
    )

  const resultMap =
    new Map()

  for (const parentId of parentIds) {
    const allIds =
      idsByParent.get(parentId) || []
    const pageIds =
      allIds.slice(from, to)
    const rows =
      pageIds
        .map((id) =>
          detailMap.get(id)
        )
        .filter(Boolean)
    const total =
      allIds.length

    resultMap.set(
      parentId,
      {
        rows,
        total,
        page,
        limit,
        hasMore:
          page * limit < total,
      }
    )
  }

  return resultMap
}

async function flushReplyBatch(key) {
  const queue =
    replyBatchQueues.get(key)

  if (!queue) return

  replyBatchQueues.delete(key)

  const {
    entries,
    storyId,
    episodeId,
    page,
    limit,
  } = queue

  try {
    const resultMap =
      await loadBatch({
        entries,
        storyId,
        episodeId,
        page,
        limit,
      })

    for (const entry of entries) {
      entry.resolve(
        resultMap.get(
          clean(entry.parentId)
        ) || {
          rows: [],
          total: 0,
          page,
          limit,
          hasMore: false,
        }
      )
    }
  } catch {
    await Promise.all(
      entries.map(
        async (entry) => {
          try {
            entry.resolve(
              await loadSingleReplyPage({
                parentId:
                  entry.parentId,
                storyId,
                episodeId,
                page,
                limit,
              })
            )
          } catch (error) {
            entry.reject(error)
          }
        }
      )
    )
  }
}

export function loadBatchedReplyPage({
  parentId,
  storyId,
  episodeId = null,
  page = 1,
  limit = 5,
}) {
  const safeParentId =
    clean(parentId)
  const safeStoryId =
    clean(storyId)
  const safeEpisodeId =
    clean(episodeId) || null
  const safePage = Math.max(
    1,
    Number(page || 1)
  )
  const safeLimit = Math.max(
    1,
    Number(limit || 5)
  )

  if (
    !safeParentId ||
    !safeStoryId
  ) {
    return Promise.resolve({
      rows: [],
      total: 0,
      page: safePage,
      limit: safeLimit,
      hasMore: false,
    })
  }

  const key = batchKey({
    storyId: safeStoryId,
    episodeId:
      safeEpisodeId,
    page: safePage,
    limit: safeLimit,
  })

  return new Promise(
    (resolve, reject) => {
      let queue =
        replyBatchQueues.get(key)

      if (!queue) {
        queue = {
          storyId: safeStoryId,
          episodeId:
            safeEpisodeId,
          page: safePage,
          limit: safeLimit,
          entries: [],
          scheduled: false,
        }
        replyBatchQueues.set(
          key,
          queue
        )
      }

      if (
        queue.entries.length >=
        REPLY_BATCH_QUEUE_LIMIT
      ) {
        void loadSingleReplyPage({
          parentId:
            safeParentId,
          storyId:
            safeStoryId,
          episodeId:
            safeEpisodeId,
          page: safePage,
          limit: safeLimit,
        }).then(
          resolve,
          reject
        )
        return
      }

      queue.entries.push({
        parentId:
          safeParentId,
        resolve,
        reject,
      })

      if (!queue.scheduled) {
        queue.scheduled = true

        queueMicrotask(() => {
          void flushReplyBatch(key)
        })
      }
    }
  )
}
