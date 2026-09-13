const MAX_CACHE_ENTRIES = 100

const genresResponseCache = new Map()
const genresResponseInFlight = new Map()
let genresResponseCacheVersion = 0

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
  if (genresResponseCache.has(key)) {
    genresResponseCache.delete(key)
  }

  genresResponseCache.set(key, entry)

  while (
    genresResponseCache.size >
    MAX_CACHE_ENTRIES
  ) {
    const oldestKey =
      genresResponseCache.keys().next().value

    if (!oldestKey) break

    genresResponseCache.delete(oldestKey)
  }
}

export function invalidateGenresResponseCache() {
  genresResponseCache.clear()
  genresResponseCacheVersion += 1
}

export function cacheGenresResponse(
  req,
  res,
  next
) {
  const key = getCacheKey(req)
  const cached =
    genresResponseCache.get(key)

  if (cached) {
    genresResponseCache.delete(key)
    genresResponseCache.set(key, cached)

    res.setHeader(
      'X-Shadow-Genres-Cache',
      'HIT'
    )

    return res
      .status(cached.statusCode || 200)
      .json(cached.body)
  }

  const existingInFlight =
    genresResponseInFlight.get(key)

  if (existingInFlight) {
    res.setHeader(
      'X-Shadow-Genres-Cache',
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
    'X-Shadow-Genres-Cache',
    'MISS'
  )

  const requestVersion =
    genresResponseCacheVersion

  let resolveInFlight
  const inFlightPromise =
    new Promise((resolve) => {
      resolveInFlight = resolve
    })

  genresResponseInFlight.set(
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
      genresResponseInFlight.get(key) ===
      inFlightPromise
    ) {
      genresResponseInFlight.delete(key)
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
      genresResponseCacheVersion ===
        requestVersion
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
