import { getReaderAgeAccess } from './storyAgeAccess.service.js'
import { markRequestDiagnostic } from './trafficDiagnostic.service.js'

const TTL_MS = 3 * 60 * 1000
const MAX_ENTRIES = 128
const MAX_PENDING = 128
const MAX_BODY_BYTES = 256 * 1024
const PENDING_TIMEOUT_MS = 15 * 1000
const cache = new Map()
const pending = new Map()

function remember(key, entry) {
  cache.delete(key)
  cache.set(key, entry)
  while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value)
}

function markRecommendationCache(details = {}) {
  markRequestDiagnostic({
    feature: 'story_recommendations',
    cache_state: details.cache_state || '',
    cache_reason: details.cache_reason || '',
    pending_count: pending.size,
    cache_entries: cache.size,
  })
}

function send(res, entry, state, reason = '') {
  markRecommendationCache({
    cache_state: state,
    cache_reason: reason,
  })
  res.setHeader('X-Shadow-Recommendations-Cache', state)
  res.setHeader('Cache-Control', 'private, no-store')
  return res.status(entry.status).json(entry.body)
}

export async function cachePublicStoryRecommendations(req, res, next) {
  const storyId = String(req.params.storyId || '').trim()
  if (!storyId) return next()

  let access
  try {
    access = await getReaderAgeAccess(req)
  } catch (error) {
    markRecommendationCache({
      cache_state: 'ERROR',
      cache_reason: 'age_access_failed',
    })
    return next(error)
  }

  const authorId = String(req.query.authorId || req.query.author_id || '').trim()
  const genre = String(req.query.genre || '').trim()
  const storySetting = String(
    req.query.story_setting ||
    req.query.storySetting ||
    ''
  ).trim()
  const key = JSON.stringify([
    storyId,
    authorId,
    genre,
    storySetting,
    access.can_view_adult_stories ? 'adult' : 'restricted',
  ])
  const now = Date.now()
  const cached = cache.get(key)
  const expired = Boolean(cached && cached.expiresAt <= now)

  if (cached && cached.expiresAt > now) {
    remember(key, cached)
    return send(res, cached, 'HIT', 'fresh_cache')
  }

  if (cached) cache.delete(key)

  const existing = pending.get(key)
  if (existing) {
    markRecommendationCache({
      cache_state: 'WAIT',
      cache_reason: 'in_flight',
    })

    try {
      const entry = await existing.promise
      if (res.headersSent || res.destroyed) return

      if (entry) {
        return send(
          res,
          entry,
          'WAIT',
          'shared_in_flight_result'
        )
      }

      markRecommendationCache({
        cache_state: 'ERROR',
        cache_reason: 'in_flight_timeout_or_empty',
      })
      res.setHeader('Retry-After', '2')
      return res.status(503).json({
        ok: false,
        message: 'Recommendations temporarily unavailable',
      })
    } catch (error) {
      markRecommendationCache({
        cache_state: 'ERROR',
        cache_reason: 'in_flight_rejected',
      })
      return next(error)
    }
  }

  if (pending.size >= MAX_PENDING) {
    markRecommendationCache({
      cache_state: 'ERROR',
      cache_reason: 'pending_limit_reached',
    })
    res.setHeader('Retry-After', '2')
    return res.status(503).json({
      ok: false,
      message: 'Recommendations are busy',
    })
  }

  markRecommendationCache({
    cache_state: 'MISS',
    cache_reason: expired
      ? 'expired_cache'
      : 'no_cache_entry',
  })

  let resolvePending
  const flight = {
    promise: new Promise((resolve) => {
      resolvePending = resolve
    }),
  }

  pending.set(key, flight)

  let settled = false

  const settle = (entry = null) => {
    if (settled) return

    settled = true
    clearTimeout(timeout)

    if (pending.get(key) === flight) {
      pending.delete(key)
    }

    resolvePending(entry)
  }

  const timeout = setTimeout(() => {
    markRecommendationCache({
      cache_state: 'ERROR',
      cache_reason: 'origin_timeout',
    })
    settle()
  }, PENDING_TIMEOUT_MS)

  timeout.unref?.()

  res.once('finish', () => settle())
  res.once('close', () => settle())

  res.setHeader('X-Shadow-Recommendations-Cache', 'MISS')
  res.setHeader('Cache-Control', 'private, no-store')

  const originalJson = res.json.bind(res)

  res.json = (body) => {
    let entry = null

    if (
      !settled &&
      res.statusCode === 200 &&
      body?.ok === true &&
      pending.get(key) === flight
    ) {
      entry = {
        status: 200,
        body,
        expiresAt: Date.now() + TTL_MS,
      }

      try {
        const bodyBytes = Buffer.byteLength(
          JSON.stringify(body)
        )

        if (bodyBytes <= MAX_BODY_BYTES) {
          remember(key, entry)
        } else {
          markRecommendationCache({
            cache_state: 'MISS',
            cache_reason: 'response_too_large_to_cache',
          })
        }
      } catch {
        markRecommendationCache({
          cache_state: 'MISS',
          cache_reason: 'response_size_check_failed',
        })
      }
    } else if (
      !settled &&
      res.statusCode >= 400
    ) {
      markRecommendationCache({
        cache_state: 'ERROR',
        cache_reason: 'origin_response_error',
      })
    }

    settle(entry)
    return originalJson(body)
  }

  return next()
}
