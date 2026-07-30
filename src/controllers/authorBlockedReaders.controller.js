import { supabase } from '../config/supabase.js'
import {
  saveAuthorCommentActivityLogSafely,
} from '../services/authorCommentActivity.service.js'

const DURATION_MILLISECONDS = {
  '1h': 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '3d': 3 * 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
}

const VALID_SCOPES = new Set([
  'all_author',
  'story',
])

const VALID_STATUSES = new Set([
  'all',
  'active',
  'expired',
])

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 50
const MAX_LIST_ROWS = 1000
const MAX_REASON_LENGTH = 300

function cleanText(value) {
  return String(value || '')
    .normalize('NFC')
    .trim()
    .replace(/\s+/g, ' ')
}

function normalizePage(value) {
  const number = Number(value)

  return Number.isFinite(number) && number > 0
    ? Math.floor(number)
    : 1
}

function normalizeLimit(value) {
  const number = Number(value)

  if (!Number.isFinite(number) || number < 1) {
    return DEFAULT_LIMIT
  }

  return Math.min(
    MAX_LIMIT,
    Math.floor(number)
  )
}

function normalizeStatus(value) {
  const status = cleanText(
    value || 'active'
  ).toLowerCase()

  return VALID_STATUSES.has(status)
    ? status
    : 'active'
}

function normalizeScope(value) {
  const scope = cleanText(
    value || 'all_author'
  ).toLowerCase()

  return VALID_SCOPES.has(scope)
    ? scope
    : null
}

function normalizeDuration(value) {
  const duration = cleanText(
    value || '24h'
  ).toLowerCase()

  return DURATION_MILLISECONDS[duration]
    ? duration
    : null
}

function publicReader(user) {
  return {
    id: user?.id || null,
    name:
      user?.name ||
      user?.username ||
      'Reader',
    username:
      user?.username || '',
    avatar_url:
      user?.avatar_url || '',
    bio:
      user?.bio || '',
  }
}

function publicStory(story) {
  if (!story) return null

  return {
    id: story.id,
    title:
      story.title ||
      'Untitled story',
    cover_url:
      story.cover_url || '',
    status:
      story.status || '',
  }
}

function isExpired(row) {
  const timestamp =
    new Date(
      row?.expires_at || ''
    ).getTime()

  return (
    !Number.isFinite(timestamp) ||
    timestamp <= Date.now()
  )
}

function publicBlock(
  row,
  readerMap,
  storyMap
) {
  const expired =
    !row.is_active ||
    isExpired(row)

  return {
    id: row.id,
    author_page_id:
      row.author_page_id,
    reader_user_id:
      row.reader_user_id,
    scope_type:
      row.scope_type,
    story_id:
      row.story_id || null,
    reason:
      row.reason || '',
    expires_at:
      row.expires_at,
    is_active:
      !expired,
    status:
      expired
        ? 'expired'
        : 'active',
    created_at:
      row.created_at,
    updated_at:
      row.updated_at,
    reader:
      publicReader(
        readerMap.get(
          String(
            row.reader_user_id
          )
        )
      ),
    story:
      row.story_id
        ? publicStory(
            storyMap.get(
              String(
                row.story_id
              )
            )
          )
        : null,
  }
}

async function getMyAuthorPage(userId) {
  const { data, error } = await supabase
    .from('author_pages')
    .select('id, user_id')
    .eq('user_id', userId)
    .maybeSingle()

  if (error) throw error

  return data
}

async function deactivateExpiredBlocks(
  authorPageId
) {
  const { error } = await supabase
    .from('author_blocked_readers')
    .update({
      is_active: false,
      updated_at:
        new Date().toISOString(),
    })
    .eq(
      'author_page_id',
      authorPageId
    )
    .eq('is_active', true)
    .lte(
      'expires_at',
      new Date().toISOString()
    )

  if (error) throw error
}

async function fetchReaderMap(
  readerIds
) {
  const ids = [
    ...new Set(
      readerIds
        .filter(Boolean)
        .map(String)
    ),
  ]

  if (!ids.length) {
    return new Map()
  }

  const { data, error } = await supabase
    .from('users')
    .select(
      'id, name, username, avatar_url, bio'
    )
    .in('id', ids)

  if (error) throw error

  return new Map(
    (data || []).map(
      (item) => [
        String(item.id),
        item,
      ]
    )
  )
}

async function fetchStoryMap(
  storyIds
) {
  const ids = [
    ...new Set(
      storyIds
        .filter(Boolean)
        .map(String)
    ),
  ]

  if (!ids.length) {
    return new Map()
  }

  const { data, error } = await supabase
    .from('stories')
    .select(
      'id, title, cover_url, status'
    )
    .in('id', ids)

  if (error) throw error

  return new Map(
    (data || []).map(
      (item) => [
        String(item.id),
        item,
      ]
    )
  )
}

function matchesSearch(
  block,
  search
) {
  if (!search) return true

  const values = [
    block.reader?.name,
    block.reader?.username,
    block.story?.title,
    block.reason,
  ]

  return values.some((value) =>
    String(value || '')
      .toLowerCase()
      .includes(search)
  )
}

async function findExistingScopeBlock({
  authorPageId,
  readerUserId,
  scopeType,
  storyId,
}) {
  let query = supabase
    .from('author_blocked_readers')
    .select('*')
    .eq(
      'author_page_id',
      authorPageId
    )
    .eq(
      'reader_user_id',
      readerUserId
    )
    .eq(
      'scope_type',
      scopeType
    )

  query =
    scopeType === 'story'
      ? query.eq(
          'story_id',
          storyId
        )
      : query.is(
          'story_id',
          null
        )

  const { data, error } =
    await query.maybeSingle()

  if (error) throw error

  return data
}

export async function getMyAuthorBlockedReaders(
  req,
  res
) {
  try {
    const userId =
      req.user?.user_id

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    const authorPage =
      await getMyAuthorPage(userId)

    if (!authorPage) {
      return res.status(404).json({
        ok: false,
        message:
          'Author page not found',
      })
    }

    const authorPageId =
      String(authorPage.id)
    const page =
      normalizePage(req.query.page)
    const limit =
      normalizeLimit(req.query.limit)
    const status =
      normalizeStatus(
        req.query.status
      )
    const search =
      cleanText(
        req.query.search ||
        req.query.q
      ).toLowerCase()

    await deactivateExpiredBlocks(
      authorPageId
    )

    const { data, error } = await supabase
      .from('author_blocked_readers')
      .select('*')
      .eq(
        'author_page_id',
        authorPageId
      )
      .eq(
        'author_user_id',
        String(userId)
      )
      .order(
        'created_at',
        { ascending: false }
      )
      .limit(MAX_LIST_ROWS)

    if (error) throw error

    const rows = data || []
    const [
      readerMap,
      storyMap,
    ] = await Promise.all([
      fetchReaderMap(
        rows.map(
          (item) =>
            item.reader_user_id
        )
      ),
      fetchStoryMap(
        rows.map(
          (item) =>
            item.story_id
        )
      ),
    ])

    const blocks = rows.map(
      (row) =>
        publicBlock(
          row,
          readerMap,
          storyMap
        )
    )

    const counts = {
      all: blocks.length,
      active:
        blocks.filter(
          (item) =>
            item.status ===
            'active'
        ).length,
      expired:
        blocks.filter(
          (item) =>
            item.status ===
            'expired'
        ).length,
    }

    const filtered = blocks.filter(
      (item) =>
        (
          status === 'all' ||
          item.status === status
        ) &&
        matchesSearch(
          item,
          search
        )
    )

    const total =
      filtered.length
    const totalPages =
      Math.max(
        1,
        Math.ceil(total / limit)
      )
    const safePage =
      Math.min(page, totalPages)
    const from =
      (safePage - 1) * limit

    return res.status(200).json({
      ok: true,
      page: safePage,
      limit,
      total,
      total_pages:
        totalPages,
      status,
      counts,
      blocks:
        filtered.slice(
          from,
          from + limit
        ),
    })
  } catch (error) {
    console.error(
      'GET AUTHOR BLOCKED READERS ERROR:',
      error
    )

    return res.status(500).json({
      ok: false,
      message:
        'Failed to load blocked readers',
      error: error.message,
    })
  }
}

export async function searchMyAuthorReaders(
  req,
  res
) {
  try {
    const userId =
      req.user?.user_id
    const q =
      cleanText(req.query.q)
    const safeQuery =
      q.replace(
        /[%_(),]/g,
        ''
      )

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    const authorPage =
      await getMyAuthorPage(userId)

    if (!authorPage) {
      return res.status(404).json({
        ok: false,
        message:
          'Author page not found',
      })
    }

    if (!safeQuery) {
      return res.status(200).json({
        ok: true,
        readers: [],
      })
    }

    const pattern =
      `%${safeQuery}%`

    const [
      nameResult,
      usernameResult,
    ] = await Promise.all([
      supabase
        .from('users')
        .select(
          'id, name, username, avatar_url, bio'
        )
        .eq('is_active', true)
        .neq('id', userId)
        .ilike('name', pattern)
        .limit(15),
      supabase
        .from('users')
        .select(
          'id, name, username, avatar_url, bio'
        )
        .eq('is_active', true)
        .neq('id', userId)
        .ilike(
          'username',
          pattern
        )
        .limit(15),
    ])

    const firstError = [
      nameResult.error,
      usernameResult.error,
    ].find(Boolean)

    if (firstError) {
      throw firstError
    }

    const readerMap =
      new Map()

    for (
      const reader of [
        ...(nameResult.data || []),
        ...(usernameResult.data || []),
      ]
    ) {
      readerMap.set(
        String(reader.id),
        publicReader(reader)
      )
    }

    const readers = [
      ...readerMap.values(),
    ].slice(0, 20)
    const readerIds =
      readers.map(
        (item) => item.id
      )

    let blockedReaderIds =
      new Set()

    if (readerIds.length) {
      const {
        data: blockedRows,
        error: blockedError,
      } = await supabase
        .from(
          'author_blocked_readers'
        )
        .select(
          'reader_user_id'
        )
        .eq(
          'author_page_id',
          String(authorPage.id)
        )
        .eq('is_active', true)
        .gt(
          'expires_at',
          new Date().toISOString()
        )
        .in(
          'reader_user_id',
          readerIds
        )

      if (blockedError) {
        throw blockedError
      }

      blockedReaderIds =
        new Set(
          (blockedRows || []).map(
            (item) =>
              String(
                item.reader_user_id
              )
          )
        )
    }

    return res.status(200).json({
      ok: true,
      readers:
        readers.map(
          (reader) => ({
            ...reader,
            is_blocked:
              blockedReaderIds.has(
                String(reader.id)
              ),
          })
        ),
    })
  } catch (error) {
    console.error(
      'SEARCH AUTHOR READERS ERROR:',
      error
    )

    return res.status(500).json({
      ok: false,
      message:
        'Failed to search readers',
      error: error.message,
    })
  }
}

export async function getMyAuthorBlockStories(
  req,
  res
) {
  try {
    const userId =
      req.user?.user_id

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    const authorPage =
      await getMyAuthorPage(userId)

    if (!authorPage) {
      return res.status(404).json({
        ok: false,
        message:
          'Author page not found',
      })
    }

    const { data, error } = await supabase
      .from('stories')
      .select(
        'id, title, cover_url, status, updated_at'
      )
      .eq('user_id', userId)
      .is('deleted_at', null)
      .order(
        'updated_at',
        { ascending: false }
      )
      .limit(200)

    if (error) throw error

    return res.status(200).json({
      ok: true,
      stories:
        (data || []).map(
          publicStory
        ),
    })
  } catch (error) {
    console.error(
      'GET AUTHOR BLOCK STORIES ERROR:',
      error
    )

    return res.status(500).json({
      ok: false,
      message:
        'Failed to load author stories',
      error: error.message,
    })
  }
}

export async function createMyAuthorBlockedReader(
  req,
  res
) {
  try {
    const userId =
      req.user?.user_id
    const readerUserId =
      cleanText(
        req.body?.reader_user_id ||
        req.body?.readerUserId
      )
    const scopeType =
      normalizeScope(
        req.body?.scope_type ||
        req.body?.scopeType
      )
    const storyId =
      cleanText(
        req.body?.story_id ||
        req.body?.storyId
      ) || null
    const duration =
      normalizeDuration(
        req.body?.duration
      )
    const reason =
      cleanText(
        req.body?.reason
      )

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    if (!readerUserId) {
      return res.status(400).json({
        ok: false,
        message:
          'Reader is required',
      })
    }

    if (
      String(readerUserId) ===
      String(userId)
    ) {
      return res.status(400).json({
        ok: false,
        message:
          'You cannot block yourself',
      })
    }

    if (!scopeType) {
      return res.status(400).json({
        ok: false,
        message:
          'Scope must be all_author or story',
      })
    }

    if (!duration) {
      return res.status(400).json({
        ok: false,
        message:
          'Duration is not valid',
      })
    }

    if (
      reason.length >
      MAX_REASON_LENGTH
    ) {
      return res.status(400).json({
        ok: false,
        message:
          `Reason cannot exceed ${MAX_REASON_LENGTH} characters`,
      })
    }

    if (
      scopeType === 'story' &&
      !storyId
    ) {
      return res.status(400).json({
        ok: false,
        message:
          'Story is required for story scope',
      })
    }

    const authorPage =
      await getMyAuthorPage(userId)

    if (!authorPage) {
      return res.status(404).json({
        ok: false,
        message:
          'Author page not found',
      })
    }

    const authorPageId =
      String(authorPage.id)

    const {
      data: reader,
      error: readerError,
    } = await supabase
      .from('users')
      .select(
        'id, name, username, avatar_url, bio, is_active'
      )
      .eq('id', readerUserId)
      .eq('is_active', true)
      .maybeSingle()

    if (readerError) {
      throw readerError
    }

    if (!reader) {
      return res.status(404).json({
        ok: false,
        message:
          'Reader not found',
      })
    }

    let story = null

    if (scopeType === 'story') {
      const {
        data,
        error,
      } = await supabase
        .from('stories')
        .select(
          'id, title, cover_url, status'
        )
        .eq('id', storyId)
        .eq('user_id', userId)
        .is('deleted_at', null)
        .maybeSingle()

      if (error) throw error

      if (!data) {
        return res.status(404).json({
          ok: false,
          message:
            'Story not found or does not belong to you',
        })
      }

      story = data

      const {
        data: broadBlock,
        error: broadBlockError,
      } = await supabase
        .from(
          'author_blocked_readers'
        )
        .select('id')
        .eq(
          'author_page_id',
          authorPageId
        )
        .eq(
          'reader_user_id',
          readerUserId
        )
        .eq(
          'scope_type',
          'all_author'
        )
        .eq('is_active', true)
        .gt(
          'expires_at',
          new Date().toISOString()
        )
        .maybeSingle()

      if (broadBlockError) {
        throw broadBlockError
      }

      if (broadBlock) {
        return res.status(409).json({
          ok: false,
          message:
            'This reader is already blocked from all of your stories',
        })
      }
    }

    const expiresAt =
      new Date(
        Date.now() +
        DURATION_MILLISECONDS[
          duration
        ]
      ).toISOString()
    const existing =
      await findExistingScopeBlock({
        authorPageId,
        readerUserId,
        scopeType,
        storyId,
      })
    const payload = {
      author_page_id:
        authorPageId,
      author_user_id:
        String(userId),
      reader_user_id:
        readerUserId,
      scope_type:
        scopeType,
      story_id:
        scopeType === 'story'
          ? storyId
          : null,
      reason:
        reason || null,
      expires_at:
        expiresAt,
      is_active: true,
      updated_at:
        new Date().toISOString(),
    }

    let block

    if (existing) {
      const {
        data,
        error,
      } = await supabase
        .from(
          'author_blocked_readers'
        )
        .update(payload)
        .eq('id', existing.id)
        .select('*')
        .single()

      if (error) throw error

      block = data
    } else {
      const {
        data,
        error,
      } = await supabase
        .from(
          'author_blocked_readers'
        )
        .insert(payload)
        .select('*')
        .single()

      if (error) throw error

      block = data
    }

    if (
      scopeType === 'all_author'
    ) {
      const { error } = await supabase
        .from(
          'author_blocked_readers'
        )
        .update({
          is_active: false,
          updated_at:
            new Date().toISOString(),
        })
        .eq(
          'author_page_id',
          authorPageId
        )
        .eq(
          'reader_user_id',
          readerUserId
        )
        .eq(
          'scope_type',
          'story'
        )
        .eq('is_active', true)

      if (error) throw error
    }

        await saveAuthorCommentActivityLogSafely({
      authorPageId,
      authorUserId:
        String(userId),
      actorType: 'author',
      actorUserId:
        String(userId),
      actionType:
        existing
          ? 'reader_block_updated'
          : 'reader_blocked',
      targetType:
        'reader_block',
      targetId:
        block.id,
      summary:
        scopeType === 'all_author'
          ? `Blocked ${reader.name || reader.username || 'a reader'} from all stories`
          : `Blocked ${reader.name || reader.username || 'a reader'} from ${story?.title || 'a story'}`,
      metadata: {
        reader_user_id:
          readerUserId,
        reader_name:
          reader.name ||
          reader.username ||
          '',
        scope_type:
          scopeType,
        story_id:
          scopeType === 'story'
            ? storyId
            : null,
        duration,
        expires_at:
          expiresAt,
        reason:
          reason || '',
      },
    })

    return res.status(
      existing ? 200 : 201
    ).json({
      ok: true,
      message:
        existing
          ? 'Reader block updated'
          : 'Reader blocked',
      duration,
      block:
        publicBlock(
          block,
          new Map([
            [
              String(reader.id),
              reader,
            ],
          ]),
          story
            ? new Map([
                [
                  String(story.id),
                  story,
                ],
              ])
            : new Map()
        ),
    })
  } catch (error) {
    if (error?.code === '23505') {
      return res.status(409).json({
        ok: false,
        message:
          'This reader block already exists',
      })
    }

    console.error(
      'CREATE AUTHOR BLOCKED READER ERROR:',
      error
    )

    return res.status(500).json({
      ok: false,
      message:
        'Failed to block reader',
      error: error.message,
    })
  }
}

export async function deleteMyAuthorBlockedReader(
  req,
  res
) {
  try {
    const userId =
      req.user?.user_id
    const blockId =
      cleanText(
        req.params.blockId
      )

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    if (!blockId) {
      return res.status(400).json({
        ok: false,
        message:
          'Block ID is required',
      })
    }

    const authorPage =
      await getMyAuthorPage(userId)

    if (!authorPage) {
      return res.status(404).json({
        ok: false,
        message:
          'Author page not found',
      })
    }

    const {
      data,
      error,
    } = await supabase
      .from(
        'author_blocked_readers'
      )
      .update({
        is_active: false,
        updated_at:
          new Date().toISOString(),
      })
      .eq('id', blockId)
      .eq(
        'author_page_id',
        String(authorPage.id)
      )
      .eq(
        'author_user_id',
        String(userId)
      )
            .select(
        'id, reader_user_id, scope_type, story_id, reason, expires_at'
      )
      .maybeSingle()

    if (error) throw error

    if (!data) {
      return res.status(404).json({
        ok: false,
        message:
          'Blocked reader record not found',
      })
    }

    await saveAuthorCommentActivityLogSafely({
      authorPageId:
        String(authorPage.id),
      authorUserId:
        String(userId),
      actorType: 'author',
      actorUserId:
        String(userId),
      actionType:
        'reader_unblocked',
      targetType:
        'reader_block',
      targetId:
        data.id,
      summary:
        'Unblocked a reader',
      metadata: {
        reader_user_id:
          data.reader_user_id,
        scope_type:
          data.scope_type,
        story_id:
          data.story_id || null,
        reason:
          data.reason || '',
        expires_at:
          data.expires_at ||
          null,
      },
    })

    return res.status(200).json({
      ok: true,
      deleted_id:
        data.id,
      message:
        'Reader unblocked',
    })
  } catch (error) {
    console.error(
      'DELETE AUTHOR BLOCKED READER ERROR:',
      error
    )

    return res.status(500).json({
      ok: false,
      message:
        'Failed to unblock reader',
      error: error.message,
    })
  }
}
