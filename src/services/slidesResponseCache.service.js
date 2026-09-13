const MAX_CACHE_ENTRIES = 100

const slidesResponseCache = new Map()

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

  res.setHeader(
    'X-Shadow-Slides-Cache',
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
        cacheControl:
          res.getHeader('Cache-Control') || '',
      })
    }

    return originalJson(body)
  }

  return next()
}
