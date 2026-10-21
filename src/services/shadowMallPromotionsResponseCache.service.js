const MAX_CACHE_ENTRIES = 50
const MAX_CACHE_AGE_MS = 365 * 24 * 60 * 60 * 1000

const shadowMallPromotionsCache = new Map()
const shadowMallPromotionsInFlight = new Map()
let shadowMallPromotionsCacheVersion = 0

function getCacheKey(req) {
  const entries = Object.entries(req.query || {})
    .map(([key, value]) => [
      String(key),
      Array.isArray(value)
        ? [...value].map(String).sort()
        : String(value ?? ''),
    ])
    .sort(([left], [right]) => left.localeCompare(right))

  return JSON.stringify({
    path: String(req.path || '/'),
    query: entries,
  })
}

function getCacheEntry(key) {
  const entry = shadowMallPromotionsCache.get(key)
  if (!entry) return null

  shadowMallPromotionsCache.delete(key)
  if (entry.expiresAt <= Date.now()) return null

  shadowMallPromotionsCache.set(key, entry)
  return entry
}

function setCacheEntry(key, entry) {
  const now = Date.now()
  for (const [existingKey, existingEntry] of shadowMallPromotionsCache) {
    if (existingEntry.expiresAt <= now) {
      shadowMallPromotionsCache.delete(existingKey)
    }
  }

  if (shadowMallPromotionsCache.has(key)) {
    shadowMallPromotionsCache.delete(key)
  }

  shadowMallPromotionsCache.set(key, { ...entry, expiresAt: now + MAX_CACHE_AGE_MS })

  while (shadowMallPromotionsCache.size > MAX_CACHE_ENTRIES) {
    const oldestKey = shadowMallPromotionsCache.keys().next().value
    if (!oldestKey) break
    shadowMallPromotionsCache.delete(oldestKey)
  }
}

export function invalidateShadowMallPromotionsCache() {
  shadowMallPromotionsCache.clear()
  shadowMallPromotionsInFlight.clear()
  shadowMallPromotionsCacheVersion += 1
}

export function cacheShadowMallPromotionsResponse(req, res, next) {
  res.setHeader('Cache-Control', 'no-store')

  const key = getCacheKey(req)
  const cached = getCacheEntry(key)

  if (cached) {
    res.setHeader('X-Shadow-Mall-Promotions-Cache', 'HIT')

    return res
      .status(cached.statusCode || 200)
      .json(cached.body)
  }

  const existingInFlight = shadowMallPromotionsInFlight.get(key)

  if (existingInFlight) {
    const waitVersion = shadowMallPromotionsCacheVersion
    res.setHeader('X-Shadow-Mall-Promotions-Cache', 'WAIT')

    existingInFlight.then((entry) => {
      if (res.headersSent || res.writableEnded || res.destroyed) return
      if (!entry || shadowMallPromotionsCacheVersion !== waitVersion) return next()

      return res
        .status(entry.statusCode || 200)
        .json(entry.body)
    })

    return
  }

  res.setHeader('X-Shadow-Mall-Promotions-Cache', 'MISS')

  const requestVersion = shadowMallPromotionsCacheVersion
  let resolveInFlight

  const inFlightPromise = new Promise((resolve) => {
    resolveInFlight = resolve
  })

  shadowMallPromotionsInFlight.set(key, inFlightPromise)

  let settled = false

  const settleInFlight = (entry = null) => {
    if (settled) return
    settled = true

    if (shadowMallPromotionsInFlight.get(key) === inFlightPromise) {
      shadowMallPromotionsInFlight.delete(key)
    }

    resolveInFlight(entry)
  }

  res.once('finish', () => settleInFlight(null))
  res.once('close', () => settleInFlight(null))

  const originalJson = res.json.bind(res)

  res.json = (body) => {
    let entry = null

    if (
      res.statusCode >= 200 &&
      res.statusCode < 300 &&
      body?.ok !== false &&
      shadowMallPromotionsCacheVersion === requestVersion
    ) {
      entry = {
        body,
        statusCode: res.statusCode,
      }

      setCacheEntry(key, entry)
    }

    settleInFlight(entry)

    return originalJson(body)
  }

  return next()
}
