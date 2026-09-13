const advertisementResponseCache = new Map()
const advertisementResponseInFlight = new Map()
let advertisementResponseCacheVersion = 0

function getCacheKey(req) {
  return String(req.query?.placement || '').trim()
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

  const cached = advertisementResponseCache.get(key)

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
      }

      advertisementResponseCache.set(key, entry)
    }

    settleInFlight(entry)
    return originalJson(body)
  }

  return next()
}
