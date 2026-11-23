import { getReaderAgeAccess } from './storyAgeAccess.service.js'
import { registerRuntimeInspectable } from './runtimeMemoryInspector.service.js'

const MAX_CACHE_ENTRIES = 300
const MAX_CACHE_ENTRY_BYTES = 1024 * 1024
const MAX_CACHE_TOTAL_BYTES = 16 * 1024 * 1024
const CACHE_TTL_MS = 60 * 1000
const POPULAR_STALE_GRACE_MS = 2 * 60 * 1000
const POPULAR_ORIGIN_RETRY_MS = 15 * 1000
const VIEW_SENSITIVE_INVALIDATION_MS = 20 * 1000

const VIEW_SENSITIVE_SORTS = new Set([
  'views',
  'weekly_top',
  'weekly',
  'trending',
])

const publicStoriesCache = new Map()
const publicStoriesInFlight = new Map()

let publicStoriesCacheVersion = 0
let publicStoriesViewSensitiveVersion = 0
let lastViewSensitiveInvalidationAt = 0
let viewSensitiveInvalidationTimer = null
let staleFallbacks = 0
let skippedOriginQueries = 0
let originFailuresWithStale = 0
let lastStaleFallbackAt = null

function getCacheTtlMs(req, body = null) {
  const filter = String(req?.query?.genre_filter || '').trim().toLowerCase()

  if (filter === 'wait_free') {
    const nextExpiry = (Array.isArray(body?.stories) ? body.stories : [])
      .map((story) => Date.parse(story?.next_wait_free_at || ''))
      .filter(Number.isFinite)
      .reduce((soonest, value) => Math.min(soonest, value), Infinity)

    return Number.isFinite(nextExpiry)
      ? Math.max(1000, Math.min(2 * 60 * 1000, nextExpiry - Date.now()))
      : 2 * 60 * 1000
  }

  if (filter === 'fully_free' || filter === 'completed') return 15 * 60 * 1000
  if (isViewSensitiveRequest(req)) return CACHE_TTL_MS
  return 2 * 60 * 1000
}

function getRequestSort(req) {
  return String(req?.query?.sort || 'latest')
    .trim()
    .toLowerCase()
}

function canUseStalePopularCache(req) {
  return getRequestSort(req) === 'popular' &&
    String(req?.query?.genre_filter || '').trim() === '' &&
    String(req?.query?.genre_pagination || '') !== '1'
}

function sendStalePopularCache(res, entry, originStatus) {
  staleFallbacks += 1
  lastStaleFallbackAt = new Date().toISOString()
  res.setHeader('X-Shadow-Public-Stories-Cache', 'STALE')
  res.setHeader('X-Shadow-Public-Stories-Origin-Status', String(originStatus || 500))
  res.setHeader('Cache-Control', 'private, no-store')
  res.setHeader('Warning', '110 - "Response is Stale"')
  return res.status(entry.statusCode || 200).json(entry.body)
}

function isViewSensitiveRequest(req) {
  return VIEW_SENSITIVE_SORTS.has(
    getRequestSort(req)
  )
}

async function getRequestScope(req) {
  const access = await getReaderAgeAccess(req)

  return access?.can_view_adult_stories
    ? 'adult'
    : 'restricted'
}

async function getCacheKey(req) {
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
    scope: await getRequestScope(req),
    query: entries,
  })
}

function setCacheEntry(key, entry) {
  let bodyBytes

  try {
    bodyBytes = Buffer.byteLength(
      JSON.stringify(entry.body)
    )
  } catch {
    return false
  }

  if (
    bodyBytes <= 0 ||
    bodyBytes > MAX_CACHE_ENTRY_BYTES
  ) {
    return false
  }

  if (publicStoriesCache.has(key)) {
    publicStoriesCache.delete(key)
  }

  publicStoriesCache.set(key, {
    ...entry,
    bodyBytes,
  })

  let totalBytes = 0

  for (const cached of publicStoriesCache.values()) {
    totalBytes += Number(cached.bodyBytes || 0)
  }

  while (
    publicStoriesCache.size > MAX_CACHE_ENTRIES ||
    totalBytes > MAX_CACHE_TOTAL_BYTES
  ) {
    const oldestKey = publicStoriesCache.keys().next().value

    if (oldestKey === undefined) break

    const oldest = publicStoriesCache.get(oldestKey)

    totalBytes -= Number(oldest?.bodyBytes || 0)

    publicStoriesCache.delete(oldestKey)
  }

  return true
}

function invalidateViewSensitiveEntries() {
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

      if (VIEW_SENSITIVE_SORTS.has(sort)) {
        publicStoriesCache.delete(key)
      }
    } catch {
      publicStoriesCache.delete(key)
    }
  }

  publicStoriesViewSensitiveVersion += 1
  lastViewSensitiveInvalidationAt = Date.now()
}

function clearViewSensitiveInvalidationTimer() {
  if (viewSensitiveInvalidationTimer !== null) {
    clearTimeout(viewSensitiveInvalidationTimer)
    viewSensitiveInvalidationTimer = null
  }
}

export function invalidatePublicStoriesCache({
  viewSensitiveOnly = false,
} = {}) {
  if (!viewSensitiveOnly) {
    clearViewSensitiveInvalidationTimer()
    publicStoriesCache.clear()
    publicStoriesCacheVersion += 1
    lastViewSensitiveInvalidationAt = Date.now()
    return
  }

  const now = Date.now()
  const elapsed = now - lastViewSensitiveInvalidationAt

  if (elapsed >= VIEW_SENSITIVE_INVALIDATION_MS || elapsed < 0) {
    clearViewSensitiveInvalidationTimer()
    invalidateViewSensitiveEntries()
    return
  }

  if (viewSensitiveInvalidationTimer !== null) return

  viewSensitiveInvalidationTimer = setTimeout(() => {
    viewSensitiveInvalidationTimer = null
    invalidateViewSensitiveEntries()
  }, VIEW_SENSITIVE_INVALIDATION_MS - elapsed)
  viewSensitiveInvalidationTimer.unref?.()
}

export async function cachePublicStoriesResponse(
  req,
  res,
  next
) {
  let key

  try {
    key = await getCacheKey(req)
  } catch (error) {
    return next(error)
  }

  const cached = publicStoriesCache.get(key)
  const now = Date.now()
  const age = cached ? now - Number(cached.cachedAt || 0) : Infinity
  const ttl = Number(cached?.ttlMs || CACHE_TTL_MS)
  const grace = canUseStalePopularCache(req) ? POPULAR_STALE_GRACE_MS : 0

  if (cached && (age < 0 || age > ttl + grace)) {
    publicStoriesCache.delete(key)
  }

  const retainedCache = publicStoriesCache.get(key)
  const freshCached = retainedCache && age <= ttl ? retainedCache : null
  const staleCached = retainedCache && age > ttl && age <= ttl + grace
    ? retainedCache
    : null

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

  if (staleCached && now < Number(staleCached.originRetryAfter || 0)) {
    skippedOriginQueries += 1
    return sendStalePopularCache(
      res,
      staleCached,
      staleCached.originFailureStatus
    )
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
        if (entry.isStaleFallback) {
          return sendStalePopularCache(res, entry, entry.originFailureStatus)
        }
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

  const requestViewSensitiveVersion =
    publicStoriesViewSensitiveVersion

  const requestIsViewSensitive =
    isViewSensitiveRequest(req)

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

    const globalVersionMatches =
      publicStoriesCacheVersion ===
      requestVersion

    const viewSensitiveVersionMatches =
      !requestIsViewSensitive ||
      publicStoriesViewSensitiveVersion ===
        requestViewSensitiveVersion

    const originStatus = Number(res.statusCode || 0)

    if (
      originStatus >= 500 &&
      staleCached &&
      publicStoriesCache.get(key) === staleCached &&
      Date.now() - Number(staleCached.cachedAt || 0) <=
        Number(staleCached.ttlMs || CACHE_TTL_MS) + POPULAR_STALE_GRACE_MS &&
      globalVersionMatches &&
      viewSensitiveVersionMatches
    ) {
      staleCached.originRetryAfter = Date.now() + POPULAR_ORIGIN_RETRY_MS
      staleCached.originFailureStatus = originStatus
      originFailuresWithStale += 1
      console.warn('PUBLIC STORIES CACHE FALLBACK:', getRequestSort(req), originStatus)
      settleInFlight({ ...staleCached, isStaleFallback: true })
      staleFallbacks += 1
      lastStaleFallbackAt = new Date().toISOString()
      res.setHeader('X-Shadow-Public-Stories-Cache', 'STALE')
      res.setHeader('X-Shadow-Public-Stories-Origin-Status', String(originStatus))
      res.setHeader('Cache-Control', 'private, no-store')
      res.setHeader('Warning', '110 - "Response is Stale"')
      res.status(200)
      return originalJson(staleCached.body)
    }

    if (
      res.statusCode >= 200 &&
      res.statusCode < 300 &&
      body?.ok !== false &&
      globalVersionMatches &&
      viewSensitiveVersionMatches
    ) {
      entry = {
        body,
        statusCode: res.statusCode,
        cachedAt: Date.now(),
        ttlMs: getCacheTtlMs(req, body),
      }

      setCacheEntry(key, entry)
    }

    settleInFlight(entry)

    return originalJson(body)
  }

  return next()
}

registerRuntimeInspectable({
  name: 'Public Stories Cache',
  mode: 'memory_cache',
  reader: () => ({
    state: publicStoriesInFlight.size > 0
      ? 'busy'
      : publicStoriesCache.size > 0
        ? 'cached'
        : 'empty',
    entries: publicStoriesCache.size,
    in_flight: publicStoriesInFlight.size,
    max_entries: MAX_CACHE_ENTRIES,
    ttl_seconds: CACHE_TTL_MS / 1000,
    cache_version: publicStoriesCacheVersion,
    view_sensitive_version: publicStoriesViewSensitiveVersion,
    popular_stale_grace_seconds: POPULAR_STALE_GRACE_MS / 1000,
    popular_origin_retry_seconds: POPULAR_ORIGIN_RETRY_MS / 1000,
    stale_fallbacks: staleFallbacks,
    skipped_origin_queries: skippedOriginQueries,
    origin_failures_with_stale: originFailuresWithStale,
    last_stale_fallback_at: lastStaleFallbackAt,
  }),
})
