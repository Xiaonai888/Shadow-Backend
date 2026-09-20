import { getReaderAgeAccess } from './storyAgeAccess.service.js'

const TTL_MS = 45 * 1000
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

function send(res, entry, state) {
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
    return next(error)
  }

  const authorId = String(req.query.authorId || req.query.author_id || '').trim()
  const genre = String(req.query.genre || '').trim()
  const key = JSON.stringify([
    storyId,
    authorId,
    genre,
    access.can_view_adult_stories ? 'adult' : 'restricted',
  ])
  const now = Date.now()
  const cached = cache.get(key)

  if (cached && cached.expiresAt > now) {
    remember(key, cached)
    return send(res, cached, 'HIT')
  }
  if (cached) cache.delete(key)

  const existing = pending.get(key)
  if (existing) {
    try {
      const entry = await existing.promise
      if (res.headersSent || res.destroyed) return
      if (entry) return send(res, entry, 'WAIT')
      res.setHeader('Retry-After', '2')
      return res.status(503).json({ ok: false, message: 'Recommendations temporarily unavailable' })
    } catch (error) {
      return next(error)
    }
  }

  if (pending.size >= MAX_PENDING) {
    res.setHeader('Retry-After', '2')
    return res.status(503).json({ ok: false, message: 'Recommendations are busy' })
  }

  let resolvePending
  const flight = {
    promise: new Promise((resolve) => { resolvePending = resolve }),
  }
  pending.set(key, flight)
  let settled = false
  const settle = (entry = null) => {
    if (settled) return
    settled = true
    clearTimeout(timeout)
    if (pending.get(key) === flight) pending.delete(key)
    resolvePending(entry)
  }
  const timeout = setTimeout(() => settle(), PENDING_TIMEOUT_MS)
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
      entry = { status: 200, body, expiresAt: Date.now() + TTL_MS }
      try {
        if (Buffer.byteLength(JSON.stringify(body)) <= MAX_BODY_BYTES) {
          remember(key, entry)
        }
      } catch {}
    }
    settle(entry)
    return originalJson(body)
  }

  return next()
}
