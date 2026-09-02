const CACHE_TTL_MS = 10 * 60 * 1000
const MAX_CACHE_ENTRIES = 500
const STALE_ENTRY_GRACE_MS = 30 * 60 * 1000

const entries = new Map()

function cacheKey(userId) {
  return String(userId || '').trim()
}

function getEntry(userId) {
  const key = cacheKey(userId)

  if (!key) {
    throw new Error('User ID is required for Author Profile cache')
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

  return {
    key,
    entry,
  }
}

function pruneCache(now = Date.now()) {
  for (const [key, entry] of entries) {
    if (
      !entry.request &&
      entry.expiresAt < now &&
      now - entry.lastAccessAt > STALE_ENTRY_GRACE_MS
    ) {
      entries.delete(key)
    }
  }

  if (entries.size <= MAX_CACHE_ENTRIES) return

  const removable = [...entries.entries()]
    .filter(([, entry]) => !entry.request)
    .sort(
      (left, right) =>
        left[1].lastAccessAt - right[1].lastAccessAt
    )

  for (const [key] of removable) {
    if (entries.size <= MAX_CACHE_ENTRIES) break
    entries.delete(key)
  }
}

export function invalidateMyAuthorPageCache(userId) {
  const key = cacheKey(userId)
  if (!key) return

  const entry = entries.get(key)
  if (!entry) return

  entry.generation += 1
  entry.data = null
  entry.expiresAt = 0
  entry.request = null
}

export async function getCachedMyAuthorPage(userId, loader) {
  if (typeof loader !== 'function') {
    throw new Error('Author Profile cache loader is required')
  }

  const now = Date.now()
  const { entry } = getEntry(userId)

  if (
    entry.data &&
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
    .then((payload) => {
      const safePayload =
        payload && typeof payload === 'object'
          ? payload
          : {
              has_author_page: false,
              author_page: null,
              works: [],
            }

      if (entry.generation === requestGeneration) {
        entry.data = safePayload
        entry.expiresAt = Date.now() + CACHE_TTL_MS
      }

      return safePayload
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
