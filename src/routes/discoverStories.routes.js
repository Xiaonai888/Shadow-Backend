import express from 'express'
import { rateLimit } from 'express-rate-limit'
import { createHash } from 'node:crypto'
import {
  getDiscoverStoriesFeed,
} from '../controllers/discoverStories.controller.js'
import {
  getDiscoverStoryReactionStatus,
  toggleDiscoverStoryReaction,
} from '../controllers/discoverStoryReactions.controller.js'
import {
  requireUser,
} from '../middleware/user.middleware.js'
import { markRequestDiagnostic } from '../services/trafficDiagnostic.service.js'

const router = express.Router()
const discoverFeedIpLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 1200,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {
    ok: false,
    code: 'DISCOVER_STORIES_IP_RATE_LIMIT',
    message: 'Too many Discover requests. Please retry shortly.',
  },
})

const FEED_CACHE_TTL_MS = 2000
const FEED_CACHE_MAX_ENTRIES = 80
const FEED_CACHE_MAX_BODY_BYTES = 192 * 1024
const FEED_PENDING_MAX = 120
const feedCache = new Map()
const feedPending = new Map()

function cacheFeedResult(req, res, next) {
  const userId = String(req.user?.user_id || req.user?.id || '').trim()
  const authorization = String(req.headers.authorization || '')
  if (!userId || !authorization) return next()

  const key = createHash('sha256')
    .update(JSON.stringify([userId, authorization, req.originalUrl]))
    .digest('hex')
  const now = Date.now()
  const cached = feedCache.get(key)

  if (cached && cached.expiresAt > now) {
    feedCache.delete(key)
    feedCache.set(key, cached)
    markRequestDiagnostic({ feature: 'discover_stories_feed', feed_cache: 'hit' })
    res.set('Cache-Control', 'private, no-store')
    return res.status(200).json(cached.body)
  }
  if (cached) feedCache.delete(key)

  const existing = feedPending.get(key)
  if (existing) {
    markRequestDiagnostic({ feature: 'discover_stories_feed', feed_cache: 'wait' })
    existing.then((result) => {
      if (res.headersSent || res.writableEnded || res.destroyed) return
      if (!result) return next()
      res.set('Cache-Control', 'private, no-store')
      return res.status(result.status).json(result.body)
    }).catch(next)
    return
  }

  if (feedPending.size >= FEED_PENDING_MAX) return next()

  markRequestDiagnostic({ feature: 'discover_stories_feed', feed_cache: 'miss' })
  let resolvePending
  const pending = new Promise((resolve) => {
    resolvePending = resolve
  })
  feedPending.set(key, pending)

  let finished = false
  const finish = (result) => {
    if (finished) return
    finished = true
    if (feedPending.get(key) === pending) feedPending.delete(key)
    resolvePending(result)
  }

  const originalJson = res.json.bind(res)
  res.set('Cache-Control', 'private, no-store')

  res.json = (body) => {
    const status = Number(res.statusCode || 200)
    if (status === 200 && body?.ok === true && Array.isArray(body.groups)) {
      try {
        const bodyBytes = Buffer.byteLength(JSON.stringify(body))
        if (bodyBytes <= FEED_CACHE_MAX_BODY_BYTES) {
          let expiresAt = Date.now() + FEED_CACHE_TTL_MS
          for (const group of body.groups) {
            for (const story of group?.stories || []) {
              const expiry = Date.parse(story?.expires_at || '')
              if (Number.isFinite(expiry)) expiresAt = Math.min(expiresAt, expiry)
            }
          }
          if (expiresAt > Date.now()) {
            feedCache.delete(key)
            feedCache.set(key, { body, expiresAt })
            while (feedCache.size > FEED_CACHE_MAX_ENTRIES) {
              feedCache.delete(feedCache.keys().next().value)
            }
          }
        }
      } catch {
        feedCache.delete(key)
      }
    }
    finish({ status, body })
    return originalJson(body)
  }

  res.once('close', () => finish(null))
  return next()
}

router.get('/feed', discoverFeedIpLimit, requireUser, cacheFeedResult, getDiscoverStoriesFeed)

router.get(
  '/:sourceType/:storyId/reaction',
  discoverFeedIpLimit,
  requireUser,
  getDiscoverStoryReactionStatus
)

router.post(
  '/:sourceType/:storyId/reaction',
  discoverFeedIpLimit,
  requireUser,
  toggleDiscoverStoryReaction
)

export default router
