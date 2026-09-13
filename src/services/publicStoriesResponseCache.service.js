import crypto from 'node:crypto'

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

function setCacheEntry(key, entry) {
  if (publicStoriesCache.has(key)) {
    publicStoriesCache.delete(key)
  }

  publicStoriesCache.set(key, entry)

  while (
    publicStoriesCache.size >
    MAX_CACHE_ENTRIES
  ) {
    const oldestKey =
      publicStoriesCache.keys().next().value

    if (!oldestKey) break

    publicStoriesCache.delete(oldestKey)
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
  const cached =
    publicStoriesCache.get(key)

  if (cached) {
    publicStoriesCache.delete(key)
    publicStoriesCache.set(key, cached)

    res.setHeader(
      'X-Shadow-Public-Stories-Cache',
      'HIT'
    )

    return res
      .status(cached.statusCode || 200)
      .json(cached.body)
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
      setCacheEntry(key, {
        body,
        statusCode: res.statusCode,
        cachedAt: Date.now(),
      })
    }

    return originalJson(body)
  }

  return next()
}
