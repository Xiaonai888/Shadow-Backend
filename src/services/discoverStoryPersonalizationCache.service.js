import { supabase } from '../config/supabase.js'

const HISTORY_DAYS = 30
const MAX_HISTORY_ROWS = 1000
const CACHE_TTL_MS = 5 * 60 * 1000
const MAX_CACHE_USERS = 100

const cache = new Map()
const inflight = new Map()

function countByCreator(rows, storyToCreator) {
  const counts = new Map()

  for (const row of rows || []) {
    const creatorId = storyToCreator.get(row.story_id)

    if (!creatorId) continue

    counts.set(
      creatorId,
      (counts.get(creatorId) || 0) + 1
    )
  }

  return counts
}

async function readStoryCreatorMaps(authorStoryIds, readerStoryIds) {
  const [authorResult, readerResult] = await Promise.all([
    authorStoryIds.length
      ? supabase
          .from('author_page_stories')
          .select('id, author_page_id')
          .in('id', authorStoryIds)
      : Promise.resolve({
          data: [],
          error: null,
        }),
    readerStoryIds.length
      ? supabase
          .from('reader_stories')
          .select('id, user_id')
          .in('id', readerStoryIds)
      : Promise.resolve({
          data: [],
          error: null,
        }),
  ])

  if (authorResult.error) throw authorResult.error
  if (readerResult.error) throw readerResult.error

  return {
    authorStoryToCreator: new Map(
      (authorResult.data || []).map((story) => [
        story.id,
        story.author_page_id,
      ])
    ),
    readerStoryToCreator: new Map(
      (readerResult.data || []).map((story) => [
        story.id,
        story.user_id,
      ])
    ),
  }
}

async function loadInteractionHistory(userId) {
  const historyStart = new Date(
    Date.now() -
      HISTORY_DAYS * 24 * 60 * 60 * 1000
  ).toISOString()

  const [authorViewsResult, readerViewsResult] =
    await Promise.all([
      supabase
        .from('author_page_story_views')
        .select('story_id, viewed_at')
        .eq('viewer_user_id', userId)
        .gte('viewed_at', historyStart)
        .order('viewed_at', {
          ascending: false,
        })
        .limit(MAX_HISTORY_ROWS),
      supabase
        .from('reader_story_views')
        .select('story_id, viewed_at')
        .eq('viewer_user_id', userId)
        .gte('viewed_at', historyStart)
        .order('viewed_at', {
          ascending: false,
        })
        .limit(MAX_HISTORY_ROWS),
    ])

  if (authorViewsResult.error) {
    throw authorViewsResult.error
  }

  if (readerViewsResult.error) {
    throw readerViewsResult.error
  }

  const authorViews =
    authorViewsResult.data || []
  const readerViews =
    readerViewsResult.data || []

  const authorStoryIds = [
    ...new Set(
      authorViews
        .map((row) => row.story_id)
        .filter(Boolean)
    ),
  ]

  const readerStoryIds = [
    ...new Set(
      readerViews
        .map((row) => row.story_id)
        .filter(Boolean)
    ),
  ]

  const {
    authorStoryToCreator,
    readerStoryToCreator,
  } = await readStoryCreatorMaps(
    authorStoryIds,
    readerStoryIds
  )

  return {
    authorViewCounts: countByCreator(
      authorViews,
      authorStoryToCreator
    ),
    readerViewCounts: countByCreator(
      readerViews,
      readerStoryToCreator
    ),
  }
}

function pruneExpired(now) {
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) {
      cache.delete(key)
    }
  }
}

function setCacheEntry(key, value) {
  const now = Date.now()

  pruneExpired(now)
  cache.delete(key)

  while (cache.size >= MAX_CACHE_USERS) {
    const oldestKey = cache.keys().next().value

    if (oldestKey === undefined) break

    cache.delete(oldestKey)
  }

  cache.set(key, {
    value,
    expiresAt: now + CACHE_TTL_MS,
  })
}

export function invalidateDiscoverStoryPersonalizationCache(
  userId
) {
  const key = String(userId || '').trim()

  if (!key) return

  cache.delete(key)
}

export async function getDiscoverStoryInteractionHistory(
  userId
) {
  const key = String(userId || '').trim()

  if (!key) {
    return {
      authorViewCounts: new Map(),
      readerViewCounts: new Map(),
    }
  }

  const now = Date.now()
  const cached = cache.get(key)

  if (cached && cached.expiresAt > now) {
    cache.delete(key)
    cache.set(key, cached)
    return cached.value
  }

  if (cached) {
    cache.delete(key)
  }

  if (inflight.has(key)) {
    return inflight.get(key)
  }

  const request = loadInteractionHistory(key)

  inflight.set(key, request)

  try {
    const value = await request
    setCacheEntry(key, value)
    return value
  } finally {
    if (inflight.get(key) === request) {
      inflight.delete(key)
    }
  }
}
