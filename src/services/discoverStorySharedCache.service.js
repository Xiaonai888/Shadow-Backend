import { supabase } from '../config/supabase.js'

const CACHE_TTL_MS =
  5 * 60 * 1000

let sharedCache = null
let sharedCacheExpiresAt = 0
let sharedCacheRequest = null
let sharedCacheGeneration = 0

function asTime(value) {
  return new Date(value || 0).getTime()
}

function filterUnexpiredStories(
  rows,
  nowMs
) {
  return (
    Array.isArray(rows) ? rows : []
  ).filter((story) => {
    const expiresAt =
      asTime(story?.expires_at)

    return (
      Number.isFinite(expiresAt) &&
      expiresAt > nowMs
    )
  })
}

function normalizeCache(
  value,
  nowMs
) {
  return {
    ...value,
    authorStories:
      filterUnexpiredStories(
        value?.authorStories,
        nowMs
      ),
    readerStories:
      filterUnexpiredStories(
        value?.readerStories,
        nowMs
      ),
  }
}

async function loadSharedCatalog(
  nowIso
) {
  const [
    authorStoriesResult,
    readerStoriesResult,
  ] = await Promise.all([
    supabase
      .from('author_page_stories')
      .select(
        'id, author_page_id, media_type, media_url, mime_type, caption, alt_text, text_overlay, mention_username, link_url, allow_messages, view_count, created_at, expires_at'
      )
      .eq('status', 'active')
      .gt('expires_at', nowIso)
      .order('created_at', {
        ascending: false,
      })
      .limit(300),
    supabase
      .from('reader_stories')
      .select(
        'id, user_id, media_type, media_url, mime_type, caption, alt_text, text_overlay, mention_username, link_url, allow_messages, view_count, created_at, expires_at'
      )
      .eq('status', 'active')
      .gt('expires_at', nowIso)
      .order('created_at', {
        ascending: false,
      })
      .limit(300),
  ])

  if (authorStoriesResult.error) {
    throw authorStoriesResult.error
  }

  if (readerStoriesResult.error) {
    throw readerStoriesResult.error
  }

  const authorStories =
    authorStoriesResult.data || []

  const readerStories =
    readerStoriesResult.data || []

  const authorPageIds = [
    ...new Set(
      authorStories
        .map(
          (story) =>
            story.author_page_id
        )
        .filter(Boolean)
    ),
  ]

  const readerIds = [
    ...new Set(
      readerStories
        .map(
          (story) =>
            story.user_id
        )
        .filter(Boolean)
    ),
  ]

  const [
    authorPagesResult,
    readersResult,
  ] = await Promise.all([
    authorPageIds.length
      ? supabase
          .from('author_pages')
          .select(
            'id, user_id, page_name, page_username, avatar_url, status'
          )
          .in(
            'id',
            authorPageIds
          )
          .eq('status', 'active')
      : Promise.resolve({
          data: [],
          error: null,
        }),
    readerIds.length
      ? supabase
          .from('users')
          .select(
            'id, name, username, avatar_url, is_active'
          )
          .in('id', readerIds)
          .eq('is_active', true)
      : Promise.resolve({
          data: [],
          error: null,
        }),
  ])

  if (authorPagesResult.error) {
    throw authorPagesResult.error
  }

  if (readersResult.error) {
    throw readersResult.error
  }

  return {
    authorStories,
    readerStories,
    authorPages:
      authorPagesResult.data || [],
    readers:
      readersResult.data || [],
  }
}

export function invalidateDiscoverStorySharedCache() {
  sharedCacheGeneration += 1
  sharedCache = null
  sharedCacheExpiresAt = 0
  sharedCacheRequest = null
}

export async function getDiscoverStorySharedCatalog(
  nowIso = new Date().toISOString()
) {
  const nowMs = Date.now()

  if (
    sharedCache &&
    nowMs < sharedCacheExpiresAt
  ) {
    return normalizeCache(
      sharedCache,
      nowMs
    )
  }

  if (sharedCacheRequest) {
    const value =
      await sharedCacheRequest

    return normalizeCache(
      value,
      Date.now()
    )
  }

  const requestGeneration =
    sharedCacheGeneration

  const request = (async () => {
    const value =
      await loadSharedCatalog(
        nowIso
      )

    if (
      requestGeneration ===
      sharedCacheGeneration
    ) {
      sharedCache = value
      sharedCacheExpiresAt =
        Date.now() + CACHE_TTL_MS
    }

    return value
  })()

  sharedCacheRequest = request

  try {
    const value = await request

    return normalizeCache(
      value,
      Date.now()
    )
  } finally {
    if (
      sharedCacheRequest === request
    ) {
      sharedCacheRequest = null
    }
  }
}
