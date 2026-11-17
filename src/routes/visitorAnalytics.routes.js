import express from 'express'
import { createHash } from 'node:crypto'
import { rateLimit } from 'express-rate-limit'
import { trackAnonymousVisitor } from '../controllers/visitorAnalytics.controller.js'
import { trackStorySectionRankEvent } from '../controllers/storySectionRank.controller.js'
import { createRateLimit } from '../middleware/rateLimit.middleware.js'

const router = express.Router()
const visitorTrackIpLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 900,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {
    ok: false,
    code: 'VISITOR_TRACK_IP_RATE_LIMIT',
    message: 'Too many visitor tracking requests.',
  },
})
const storySectionRankRateLimit = createRateLimit({
  key: 'visitor-story-section-rank',
  windowMs: 60 * 1000,
  max: 120,
  message: 'Too many ranking events. Please try again later.',
})
const visitorPending = new Map()
const VISITOR_PENDING_MAX = 150

function coalesceVisitorTrack(req, res, next) {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) return next()

  let fingerprint
  try {
    fingerprint = JSON.stringify([
      req.ip,
      req.headers['user-agent'] || '',
      req.body,
    ])
  } catch {
    return next()
  }
  if (fingerprint.length > 16000) return next()

  const key = createHash('sha256').update(fingerprint).digest('hex')
  const waiting = visitorPending.get(key)
  if (waiting) {
    waiting.then((result) => {
      if (res.headersSent || res.writableEnded || res.destroyed) return
      if (!result) return next()
      res.set('Cache-Control', 'private, no-store')
      return res.status(200).json(result)
    }).catch(next)
    return
  }
  if (visitorPending.size >= VISITOR_PENDING_MAX) return next()

  let release
  const pending = new Promise((resolve) => { release = resolve })
  visitorPending.set(key, pending)

  let settled = false
  function finish(result) {
    if (settled) return
    settled = true
    if (visitorPending.get(key) === pending) visitorPending.delete(key)
    release(result)
  }

  const originalJson = res.json.bind(res)
  res.json = (body) => {
    const successful = res.statusCode === 200 && body?.ok === true
    finish(successful ? body : null)
    return originalJson(body)
  }
  res.once('close', () => finish(null))
  return next()
}

router.post('/track', visitorTrackIpLimit, coalesceVisitorTrack, trackAnonymousVisitor)
router.post('/story-section-rank', storySectionRankRateLimit, trackStorySectionRankEvent)

export default router
