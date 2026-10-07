const CACHE_TTL_MS = 24 * 60 * 60 * 1000
const MAX_CACHE_ENTRIES = 200

const publicStoryDataCache = new Map()
const publicStoryDataVersions = new Map()

let publicStoryDataGlobalVersion = 0

function normalizeStoryId(value) {
  return String(value || '').trim()
}

function getStoryVersion(storyId) {
  return Number(
    publicStoryDataVersions.get(storyId) || 0
  )
}

function getCacheKey({
  storyId,
  resource,
}) {
  return [
    normalizeStoryId(storyId),
    String(resource || 'detail'),
  ].join(':')
}

function isSafePublicResponse(
  resource,
  body
) {
  if (!body || body.ok === false) {
    return false
  }

  if (resource === 'detail') {
    return (
      body.story &&
      !Boolean(body.story.is_adult)
    )
  }

  if (resource === 'episodes') {
    return body.story_is_adult === false
  }

  return false
}

function setCacheEntry(key, entry) {
  if (publicStoryDataCache.has(key)) {
    publicStoryDataCache.delete(key)
  }

  publicStoryDataCache.set(key, entry)

  while (
    publicStoryDataCache.size >
    MAX_CACHE_ENTRIES
  ) {
    const oldestKey =
      publicStoryDataCache.keys().next().value

    if (!oldestKey) break

    publicStoryDataCache.delete(oldestKey)
  }
}

function deleteStoryKeys(storyId) {
  const prefix = `${storyId}:`

  for (const key of publicStoryDataCache.keys()) {
    if (String(key).startsWith(prefix)) {
      publicStoryDataCache.delete(key)
    }
  }
}

export function invalidatePublicStoryDataCache(
  storyId = ''
) {
  const normalizedStoryId =
    normalizeStoryId(storyId)

  if (!normalizedStoryId) {
    publicStoryDataCache.clear()
    publicStoryDataVersions.clear()
    publicStoryDataGlobalVersion += 1
    return
  }

  deleteStoryKeys(normalizedStoryId)

  publicStoryDataVersions.set(
    normalizedStoryId,
    getStoryVersion(normalizedStoryId) + 1
  )
}

export function cachePublicStoryDataResponse(
  resource = 'detail'
) {
  return function publicStoryDataCacheMiddleware(
    req,
    res,
    next
  ) {
    const storyId = normalizeStoryId(
      req.params?.storyId
    )

    if (!storyId) {
      return next()
    }

    const key = getCacheKey({
      storyId,
      resource,
    })

    const cached =
      publicStoryDataCache.get(key)

    if (
      cached &&
      Date.now() -
        Number(cached.cachedAt || 0) >
        CACHE_TTL_MS
    ) {
      publicStoryDataCache.delete(key)
    }

    const freshCached =
      publicStoryDataCache.get(key)

    if (freshCached) {
      publicStoryDataCache.delete(key)
      publicStoryDataCache.set(
        key,
        freshCached
      )

      res.setHeader(
        'X-Shadow-Public-Story-Cache',
        'HIT'
      )

      return res
        .status(
          freshCached.statusCode || 200
        )
        .json(freshCached.body)
    }

    res.setHeader(
      'X-Shadow-Public-Story-Cache',
      'MISS'
    )

    const requestGlobalVersion =
      publicStoryDataGlobalVersion

    const requestStoryVersion =
      getStoryVersion(storyId)

    const originalJson =
      res.json.bind(res)

    res.json = (body) => {
      const versionMatches =
        publicStoryDataGlobalVersion ===
          requestGlobalVersion &&
        getStoryVersion(storyId) ===
          requestStoryVersion

      if (
        res.statusCode >= 200 &&
        res.statusCode < 300 &&
        versionMatches &&
        isSafePublicResponse(
          resource,
          body
        )
      ) {
        setCacheEntry(
          key,
          {
            body,
            statusCode: res.statusCode,
            cachedAt: Date.now(),
          }
        )
      }

      return originalJson(body)
    }

    return next()
  }
}
