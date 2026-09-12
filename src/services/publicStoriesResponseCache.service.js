import crypto from 'node:crypto'

const DYNAMIC_CACHE_MS = 30 * 60 * 1000
const UPDATE_CACHE_MS = 2 * 60 * 60 * 1000
const DEFAULT_CACHE_MS = 6 * 60 * 60 * 1000
const MAX_CACHE_ENTRIES = 300

const publicStoriesCache = new Map()

function getRequestScope(req) {
  const authHeader = String(
    req.headers.authorization || ''
  )

  const token = authHeader.startsWith('Bearer ')
    ? authHeader.slice(7).trim()
    : ''

  if (!token) return 'anon'

  return crypto
    .createHash('sha256')
    .update(token)
    .digest('hex')
    .slice(0, 20)
}

function getCacheMaxAge(req) {
  const sort = String(
    req.query.sort || 'latest'
  )
    .trim()
    .toLowerCase()

  if (
    [
      'popular',
      'trending',
      'weekly_top',
      'weekly',
      'views',
      'likes',
      'comments',
    ].includes(sort)
  ) {
    return DYNAMIC_CACHE_MS
  }

  if (
    [
      'episode_updated',
      'weekly_updates',
    ].includes(sort)
  ) {
    return UPDATE_CACHE_MS
  }

  return DEFAULT_CACHE_MS
}

function getCacheKey(req) {
  const entries = Object.entries(
    req.query || {}
  )
    .map(([key, value]) => [
      String(key),
      Array.isArray(value)
        ? [...value].map(String).sort()
        : String(value ?? ''),
    ])
    .sort(([left], [right]) =>
      left.localeCompare(right)
    )

  return JSON.stringify({
    scope: getRequestScope(req),
    query: entries,
  })
}

function pruneCache() {
  const now = Date.now()

  for (
    const [key, entry] of
    publicStoriesCache.entries()
  ) {
    if (
      !entry ||
      now >= Number(entry.expiresAt || 0)
    ) {
      publicStoriesCache.delete(key)
    }
  }

  if (
    publicStoriesCache.size <=
    MAX_CACHE_ENTRIES
  ) {
    return
  }

  const overflow =
    publicStoriesCache.size -
    MAX_CACHE_ENTRIES

  const oldestKeys = [
    ...publicStoriesCache.entries(),
  ]
    .sort(
      (left, right) =>
        Number(left[1]?.cachedAt || 0) -
        Number(right[1]?.cachedAt || 0)
    )
    .slice(0, overflow)
    .map(([key]) => key)

  for (const key of oldestKeys) {
    publicStoriesCache.delete(key)
  }
}

export function invalidatePublicStoriesCache() {
  publicStoriesCache.clear()
}

export function cachePublicStoriesResponse(
  req,
  res,
  next
) {
  const key = getCacheKey(req)
  const now = Date.now()
  const cached =
    publicStoriesCache.get(key)

  if (
    cached &&
    now < Number(cached.expiresAt || 0)
  ) {
    res.setHeader(
      'X-Shadow-Public-Stories-Cache',
      'HIT'
    )

    return res
      .status(cached.statusCode || 200)
      .json(cached.body)
  }

  if (cached) {
    publicStoriesCache.delete(key)
  }

  res.setHeader(
    'X-Shadow-Public-Stories-Cache',
    'MISS'
  )

  const originalJson = res.json.bind(res)

  res.json = (body) => {
    if (
      res.statusCode >= 200 &&
      res.statusCode < 300 &&
      body?.ok !== false
    ) {
      const maxAgeMs =
        getCacheMaxAge(req)

      publicStoriesCache.set(key, {
        body,
        statusCode: res.statusCode,
        cachedAt: Date.now(),
        expiresAt:
          Date.now() + maxAgeMs,
      })

      pruneCache()
    }

    return originalJson(body)
  }

  return next()
}
