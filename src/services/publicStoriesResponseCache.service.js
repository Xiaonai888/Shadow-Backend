import crypto from 'node:crypto'

const MAX_CACHE_ENTRIES = 300
const CACHE_TTL_MS = 60 * 1000

const publicStoriesCache = new Map()
const publicStoriesInFlight = new Map()
let publicStoriesCacheVersion = 0

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

export function invalidatePublicStoriesCache({
  viewSensitiveOnly = false,
} = {}) {
  if (!viewSensitiveOnly) {
    publicStoriesCache.clear()
    publicStoriesCacheVersion += 1
    return
  }

  const viewSensitiveSorts = new Set([
    'views',
    'popular',
    'weekly_top',
    'weekly',
    'trending',
  ])

  for (const key of publicStoriesCache.keys()) {
    try {
      const parsed = JSON.parse(key)
      const queryEntries = Array.isArray(parsed?.query)
        ? parsed.query
        : []
      const query = Object.fromEntries(queryEntries)
      const sort = String(query.sort || 'latest')
        .trim()
        .toLowerCase()

      if (viewSensitiveSorts.has(sort)) {
        publicStoriesCache.delete(key)
      }
    } catch {
      publicStoriesCache.delete(key)
    }
  }

  publicStoriesCacheVersion += 1
}

export function cachePublicStoriesResponse(
  req,
  res,
  next
) {
  const key = getCacheKey(req)
  const cached =
    publicStoriesCache.get(key)

  if (
    cached &&
    Date.now() - Number(cached.cachedAt || 0) >
      CACHE_TTL_MS
  ) {
    publicStoriesCache.delete(key)
  }

  const freshCached =
    publicStoriesCache.get(key)

  if (freshCached) {
    publicStoriesCache.delete(key)
    publicStoriesCache.set(key, freshCached)

    res.setHeader(
      'X-Shadow-Public-Stories-Cache',
      'HIT'
    )

    return res
      .status(freshCached.statusCode || 200)
      .json(freshCached.body)
  }

  const existingInFlight =
    publicStoriesInFlight.get(key)

  if (existingInFlight) {
    res.setHeader(
      'X-Shadow-Public-Stories-Cache',
      'WAIT'
    )

    existingInFlight.then((entry) => {
      if (res.headersSent) return

      if (entry) {
        return res
          .status(entry.statusCode || 200)
          .json(entry.body)
      }

      return next()
    })

    return
  }

  res.setHeader(
    'X-Shadow-Public-Stories-Cache',
    'MISS'
  )

  const requestVersion =
    publicStoriesCacheVersion

  let resolveInFlight
  const inFlightPromise =
    new Promise((resolve) => {
      resolveInFlight = resolve
    })

  publicStoriesInFlight.set(
    key,
    inFlightPromise
  )

  let settled = false

  const settleInFlight = (
    entry = null
  ) => {
    if (settled) return
    settled = true

    if (
      publicStoriesInFlight.get(key) ===
      inFlightPromise
    ) {
      publicStoriesInFlight.delete(key)
    }

    resolveInFlight(entry)
  }

  res.once(
    'finish',
    () => settleInFlight(null)
  )
  res.once(
    'close',
    () => settleInFlight(null)
  )

  const originalJson = res.json.bind(res)

  res.json = (body) => {
    let entry = null

    if (
      res.statusCode >= 200 &&
      res.statusCode < 300 &&
      body?.ok !== false &&
      publicStoriesCacheVersion ===
        requestVersion
    ) {
      entry = {
        body,
        statusCode: res.statusCode,
        cachedAt: Date.now(),
      }

      setCacheEntry(key, entry)
    }

    settleInFlight(entry)

    return originalJson(body)
  }

  return next()
}
