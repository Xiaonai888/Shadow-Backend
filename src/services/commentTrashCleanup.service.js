import { supabase } from '../config/supabase.js'

const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000
const CLEANUP_START_DELAY_MS = 3 * 60 * 1000
const MAX_ROOTS_PER_RUN = 100
const ID_BATCH_SIZE = 100
const MAX_TREE_DEPTH = 20

let cleanupStarted = false
let cleanupRunning = false

function chunkIds(ids) {
  const chunks = []

  for (let index = 0; index < ids.length; index += ID_BATCH_SIZE) {
    chunks.push(ids.slice(index, index + ID_BATCH_SIZE))
  }

  return chunks
}

async function loadExpiredRootIds(table, now) {
  const { data, error } = await supabase
    .from(table)
    .select('id')
    .not('deleted_at', 'is', null)
    .not('delete_expires_at', 'is', null)
    .lte('delete_expires_at', now)
    .order('delete_expires_at', { ascending: true })
    .limit(MAX_ROOTS_PER_RUN)

  if (error) throw error

  return (data || [])
    .map((item) => item.id)
    .filter(Boolean)
}

async function loadChildIds(table, parentIds) {
  const childIds = []

  for (const batch of chunkIds(parentIds)) {
    const { data, error } = await supabase
      .from(table)
      .select('id')
      .in('parent_id', batch)

    if (error) throw error

    childIds.push(
      ...(data || [])
        .map((item) => item.id)
        .filter(Boolean)
    )
  }

  return childIds
}

async function collectTreeLevels(table, rootIds) {
  if (!rootIds.length) return []

  const seen = new Set(rootIds.map(String))
  const levels = [rootIds]
  let frontier = rootIds

  for (let depth = 0; depth < MAX_TREE_DEPTH; depth += 1) {
    const children = await loadChildIds(table, frontier)
    const next = children.filter((id) => {
      const key = String(id)

      if (seen.has(key)) return false

      seen.add(key)
      return true
    })

    if (!next.length) break

    levels.push(next)
    frontier = next
  }

  return levels
}

async function deleteRows(table, column, ids) {
  if (!ids.length) return

  for (const batch of chunkIds(ids)) {
    const { error } = await supabase
      .from(table)
      .delete()
      .in(column, batch)

    if (error) throw error
  }
}

async function deleteCommentTree(table, levels) {
  for (const level of [...levels].reverse()) {
    await deleteRows(table, 'id', level)
  }
}

async function purgeStoryComments(now) {
  const rootIds = await loadExpiredRootIds('comments', now)

  if (!rootIds.length) {
    return 0
  }

  const levels = await collectTreeLevels('comments', rootIds)
  const allIds = levels.flat()

  await deleteRows('comment_likes', 'comment_id', allIds)
  await deleteRows(
    'author_hidden_comment_reviews',
    'comment_id',
    allIds
  )
  await deleteCommentTree('comments', levels)

  return allIds.length
}

async function purgeAuthorPostComments(now) {
  const rootIds = await loadExpiredRootIds(
    'author_page_post_comments',
    now
  )

  if (!rootIds.length) {
    return 0
  }

  const levels = await collectTreeLevels(
    'author_page_post_comments',
    rootIds
  )
  const allIds = levels.flat()

  await deleteRows(
    'author_page_post_comment_likes',
    'comment_id',
    allIds
  )
  await deleteCommentTree(
    'author_page_post_comments',
    levels
  )

  return allIds.length
}

export async function runCommentTrashCleanup() {
  if (cleanupRunning) {
    return {
      ok: true,
      skipped: true,
      deleted_count: 0,
    }
  }

  cleanupRunning = true

  try {
    const now = new Date().toISOString()

    const storyDeleted = await purgeStoryComments(now)
    const authorPostDeleted =
      await purgeAuthorPostComments(now)
    const deletedCount =
      storyDeleted + authorPostDeleted

    if (deletedCount > 0) {
      console.log(
        `COMMENT TRASH AUTO CLEANUP DELETED: ${deletedCount}`
      )
    }

    return {
      ok: true,
      deleted_count: deletedCount,
      story_comment_count: storyDeleted,
      author_post_comment_count: authorPostDeleted,
    }
  } catch (error) {
    console.error(
      'COMMENT TRASH AUTO CLEANUP ERROR:',
      error
    )

    return {
      ok: false,
      deleted_count: 0,
      error: String(
        error?.message || error || ''
      ),
    }
  } finally {
    cleanupRunning = false
  }
}

export function startCommentTrashCleanup() {
  if (
    cleanupStarted ||
    process.env.ENABLE_COMMENT_TRASH_AUTO_CLEANUP ===
      'false'
  ) {
    return
  }

  cleanupStarted = true

  const startTimer = setTimeout(() => {
    runCommentTrashCleanup()
  }, CLEANUP_START_DELAY_MS)

  const interval = setInterval(() => {
    runCommentTrashCleanup()
  }, CLEANUP_INTERVAL_MS)

  startTimer.unref?.()
  interval.unref?.()
}
