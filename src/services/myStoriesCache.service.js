const CACHE_TTL_MS = 2 * 60 * 1000
const MAX_CACHE_ENTRIES = 500
const STALE_ENTRY_GRACE_MS = 10 * 60 * 1000

const entries = new Map()

function cacheKey(userId) {
  return String(userId || '').trim()
}

function getEntry(userId) {
  const key = cacheKey(userId)

  if (!key) {
    throw new Error('User ID is required for My Stories cache')
  }

  let entry = entries.get(key)

  if (!entry) {
    entry = {
      data: null,
      expiresAt: 0,
      request: null,
      generation: 0,
      lastAccessAt: Date.now(),
    }
    entries.set(key, entry)
  }

  entry.lastAccessAt = Date.now()
  return { key, entry }
}

function pruneCache(now = Date.now()) {
  if (entries.size <= MAX_CACHE_ENTRIES) return

  for (const [key, entry] of entries) {
    if (entries.size <= MAX_CACHE_ENTRIES) break

    if (
      !entry.request &&
      entry.expiresAt < now &&
      now - entry.lastAccessAt > STALE_ENTRY_GRACE_MS
    ) {
      entries.delete(key)
    }
  }
}

export function invalidateMyStoriesCache(userId) {
  const key = cacheKey(userId)
  if (!key) return

  const { entry } = getEntry(key)

  entry.generation += 1
  entry.data = null
  entry.expiresAt = 0
  entry.request = null

  pruneCache()
}

export async function getCachedMyStories(userId, loader) {
  if (typeof loader !== 'function') {
    throw new Error('My Stories cache loader is required')
  }

  const now = Date.now()
  const { entry } = getEntry(userId)

  if (
    Array.isArray(entry.data) &&
    now < entry.expiresAt
  ) {
    return entry.data
  }

  if (entry.request) {
    return entry.request
  }

  const requestGeneration = entry.generation

  const request = Promise.resolve()
    .then(loader)
    .then((stories) => {
      const safeStories = Array.isArray(stories)
        ? stories
        : []

      if (entry.generation === requestGeneration) {
        entry.data = safeStories
        entry.expiresAt = Date.now() + CACHE_TTL_MS
      }

      return safeStories
    })

  entry.request = request

  try {
    return await request
  } finally {
    if (entry.request === request) {
      entry.request = null
    }

    pruneCache()
  }
}
