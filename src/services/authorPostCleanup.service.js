import { supabase } from '../config/supabase.js'

const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000
const CLEANUP_START_DELAY_MS = 2 * 60 * 1000
const MAX_POSTS_PER_RUN = 100

let cleanupStarted = false
let cleanupRunning = false

async function deleteSavedPostRows(postIds) {
  const { data, error } = await supabase
    .from('saved_posts')
    .select('id')
    .eq('source_type', 'author_post')
    .in('source_id', postIds)

  if (error) throw error

  const savedPostIds = (data || [])
    .map((item) => item.id)
    .filter(Boolean)

  if (!savedPostIds.length) return

  const { error: collectionError } = await supabase
    .from('saved_post_collection_items')
    .delete()
    .in('saved_post_id', savedPostIds)

  if (collectionError) throw collectionError

  const { error: savedError } = await supabase
    .from('saved_posts')
    .delete()
    .in('id', savedPostIds)

  if (savedError) throw savedError
}

async function deleteByPostIds(table, postIds) {
  const { error } = await supabase
    .from(table)
    .delete()
    .in('post_id', postIds)

  if (error) throw error
}

export async function runAuthorPostCleanup() {
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

    const { data, error } = await supabase
      .from('author_page_posts')
      .select('id')
      .eq('status', 'deleted')
      .not('admin_archive_expires_at', 'is', null)
      .lte('admin_archive_expires_at', now)
      .order('admin_archive_expires_at', {
        ascending: true,
      })
      .limit(MAX_POSTS_PER_RUN)

    if (error) throw error

    const postIds = (data || [])
      .map((item) => item.id)
      .filter(Boolean)

    if (!postIds.length) {
      return {
        ok: true,
        deleted_count: 0,
      }
    }

    await deleteSavedPostRows(postIds)
    await deleteByPostIds(
      'author_post_notification_preferences',
      postIds
    )
    await deleteByPostIds(
      'author_page_post_echoes',
      postIds
    )
    await deleteByPostIds(
      'author_page_post_reactions',
      postIds
    )
    await deleteByPostIds(
      'author_page_post_comments',
      postIds
    )

    const { data: deletedPosts, error: deleteError } =
      await supabase
        .from('author_page_posts')
        .delete()
        .in('id', postIds)
        .eq('status', 'deleted')
        .lte('admin_archive_expires_at', now)
        .select('id')

    if (deleteError) throw deleteError

    const deletedCount = (deletedPosts || []).length

    if (deletedCount > 0) {
      console.log(
        `AUTHOR POST AUTO CLEANUP DELETED: ${deletedCount}`
      )
    }

    return {
      ok: true,
      deleted_count: deletedCount,
    }
  } catch (error) {
    console.error(
      'AUTHOR POST AUTO CLEANUP ERROR:',
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

export function startAuthorPostCleanup() {
  if (
    cleanupStarted ||
    process.env.ENABLE_AUTHOR_POST_AUTO_CLEANUP ===
      'false'
  ) {
    return
  }

  cleanupStarted = true

  const startTimer = setTimeout(() => {
    runAuthorPostCleanup()
  }, CLEANUP_START_DELAY_MS)

  const interval = setInterval(() => {
    runAuthorPostCleanup()
  }, CLEANUP_INTERVAL_MS)

  startTimer.unref?.()
  interval.unref?.()
}
