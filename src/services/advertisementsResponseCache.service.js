const advertisementResponseCache = new Map()
const advertisementResponseInFlight = new Map()
let advertisementResponseCacheVersion = 0

const ROTATING_PLACEMENTS = new Set(['opening', 'freeUnlock', 'me'])
const MAX_CACHE_AGE_MS = 5 * 60 * 1000

function getCacheKey(req) {
  return String(req.query?.placement || '').trim()
}

function getExpiresAt(key, body) {
  const now = Date.now()
  const maxExpiresAt = now + MAX_CACHE_AGE_MS

  if (!ROTATING_PLACEMENTS.has(key) || body?.rotation?.mode !== 'auto') {
    return maxExpiresAt
  }

  const seconds = Number(body?.rotation?.rotate_every_seconds || 0)
  const startedAt = Date.parse(body?.rotation?.rotation_started_at || '')

  if (!Number.isFinite(seconds) || seconds <= 0) return now + 1000

  const stepMs = seconds * 1000
  if (!Number.isFinite(startedAt)) {
    return now + Math.min(stepMs, 60000, MAX_CACHE_AGE_MS)
  }

  const elapsedMs = Math.max(0, now - startedAt)
  const remainingMs = stepMs - (elapsedMs % stepMs)

  return Math.min(maxExpiresAt, now + Math.max(1, remainingMs))
}

export function invalidateAdvertisementResponseCache(placement = '') {
  const key = String(placement || '').trim()

  if (key) {
    advertisementResponseCache.delete(key)
    advertisementResponseInFlight.delete(key)
  } else {
    advertisementResponseCache.clear()
    advertisementResponseInFlight.clear()
  }

  advertisementResponseCacheVersion += 1
}

export function cacheAdvertisementResponse(req, res, next) {
  const key = getCacheKey(req)

  if (!key) return next()

  let cached = advertisementResponseCache.get(key)

  if (cached?.expiresAt && cached.expiresAt <= Date.now()) {
    advertisementResponseCache.delete(key)
    cached = null
  }

  if (cached) {
    res.setHeader('X-Shadow-Advertisement-Cache', 'HIT')
    return res.status(cached.statusCode || 200).json(cached.body)
  }

  const existingInFlight = advertisementResponseInFlight.get(key)

  if (existingInFlight) {
    res.setHeader('X-Shadow-Advertisement-Cache', 'WAIT')

    existingInFlight.then((entry) => {
      if (res.headersSent) return
      if (!entry) return next()

      return res.status(entry.statusCode || 200).json(entry.body)
    })

    return
  }

  res.setHeader('X-Shadow-Advertisement-Cache', 'MISS')

  const requestVersion = advertisementResponseCacheVersion
  let resolveInFlight

  const inFlightPromise = new Promise((resolve) => {
    resolveInFlight = resolve
  })

  advertisementResponseInFlight.set(key, inFlightPromise)

  let settled = false

  const settleInFlight = (entry = null) => {
    if (settled) return
    settled = true

    if (advertisementResponseInFlight.get(key) === inFlightPromise) {
      advertisementResponseInFlight.delete(key)
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
      advertisementResponseCacheVersion === requestVersion
    ) {
      entry = {
        body,
        statusCode: res.statusCode,
        expiresAt: getExpiresAt(key, body),
      }

      advertisementResponseCache.set(key, entry)
    }

    settleInFlight(entry)
    return originalJson(body)
  }

  return next()
}
