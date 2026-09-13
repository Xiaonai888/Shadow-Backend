const MAX_CACHE_ENTRIES = 100

const slidesResponseCache = new Map()
const slidesResponseInFlight = new Map()
let slidesResponseCacheVersion = 0

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
    path: String(req.path || '/'),
    query: entries,
  })
}

function setCacheEntry(key, entry) {
  if (slidesResponseCache.has(key)) {
    slidesResponseCache.delete(key)
  }

  slidesResponseCache.set(key, entry)

  while (
    slidesResponseCache.size >
    MAX_CACHE_ENTRIES
  ) {
    const oldestKey =
      slidesResponseCache.keys().next().value

    if (!oldestKey) break

    slidesResponseCache.delete(oldestKey)
  }
}

export function invalidateSlidesResponseCache() {
  slidesResponseCache.clear()
  slidesResponseCacheVersion += 1
}

export function cacheSlidesResponse(
  req,
  res,
  next
) {
  const key = getCacheKey(req)
  const cached =
    slidesResponseCache.get(key)

  if (cached) {
    slidesResponseCache.delete(key)
    slidesResponseCache.set(key, cached)

    if (cached.cacheControl) {
      res.setHeader(
        'Cache-Control',
        cached.cacheControl
      )
    }

    res.setHeader(
      'X-Shadow-Slides-Cache',
      'HIT'
    )

    return res
      .status(cached.statusCode || 200)
      .json(cached.body)
  }

  const existingInFlight =
    slidesResponseInFlight.get(key)

  if (existingInFlight) {
    res.setHeader(
      'X-Shadow-Slides-Cache',
      'WAIT'
    )

    existingInFlight.then((entry) => {
      if (res.headersSent) return

      if (entry) {
        if (entry.cacheControl) {
          res.setHeader(
            'Cache-Control',
            entry.cacheControl
          )
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
    'X-Shadow-Slides-Cache',
    'MISS'
  )

  const requestVersion =
    slidesResponseCacheVersion

  let resolveInFlight
  const inFlightPromise =
    new Promise((resolve) => {
      resolveInFlight = resolve
    })

  slidesResponseInFlight.set(
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
      slidesResponseInFlight.get(key) ===
      inFlightPromise
    ) {
      slidesResponseInFlight.delete(key)
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
      slidesResponseCacheVersion ===
        requestVersion
    ) {
      entry = {
        body,
        statusCode: res.statusCode,
        cacheControl:
          res.getHeader('Cache-Control') || '',
      }

      setCacheEntry(key, entry)
    }

    settleInFlight(entry)

    return originalJson(body)
  }

  return next()
}
