import { createHash } from 'node:crypto'
import { rateLimit } from 'express-rate-limit'
import express from 'express'
import {
  getReadingProgress,
  saveReadingProgress,
} from '../controllers/readingProgress.controller.js'
import { requireUser } from '../middleware/user.middleware.js'
import {
  traceReadingProgressRead,
  traceReadingProgressSave,
} from '../middleware/episodeViewDiagnostics.middleware.js'

const router = express.Router()
router.use(rateLimit({
  windowMs: 60 * 1000,
  limit: 1200,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
}))

const progressPreAuthLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 1200,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {
    ok: false,
    code: 'READING_PROGRESS_IP_RATE_LIMIT',
    message: 'Too many reading progress requests.',
  },
})

const progressRateLimit = rateLimit({
  windowMs: 60000,
  limit: 120,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req) => `${String(req.user?.user_id || req.user?.id || 'unauthenticated')}:${req.method}`,
  message: {
    ok: false,
    code: 'READING_PROGRESS_RATE_LIMIT',
    message: 'Too many reading progress requests. Please try again shortly.',
  },
})

const PROGRESS_READ_TTL_MS = 2500
const PROGRESS_READ_MAX_ENTRIES = 150
const PROGRESS_READ_MAX_BODY_BYTES = 256 * 1024
const PROGRESS_PENDING_LIMIT = 150
const progressResponseCache = new Map()
const progressPending = new Map()
let progressCacheGeneration = 0

function invalidateProgressAfterWrite(req, res, next) {
  res.once('finish', () => {
    if (res.statusCode >= 200 && res.statusCode < 300) {
      progressCacheGeneration += 1
      progressResponseCache.clear()
    }
  })
  return next()
}

function coalesceProgressRead(req, res, next) {
  const userId = String(req.user?.user_id || req.user?.id || '').trim()
  const token = String(req.headers.authorization || '')
  if (!userId || !token) return next()

  const generation = progressCacheGeneration
  const key = createHash('sha256')
    .update(JSON.stringify([userId, token, req.originalUrl]))
    .digest('hex')
  const now = Date.now()
  const cached = progressResponseCache.get(key)

  if (cached && cached.generation === generation && cached.expiresAt > now) {
    progressResponseCache.delete(key)
    progressResponseCache.set(key, cached)
    res.set('Cache-Control', 'private, no-store')
    return res.status(200).json(cached.body)
  }
  if (cached) progressResponseCache.delete(key)

  const pendingKey = `${generation}:${key}`
  const active = progressPending.get(pendingKey)
  if (active) {
    active.then((result) => {
      if (res.headersSent || res.writableEnded || res.destroyed) return
      if (!result || progressCacheGeneration !== generation) return next()
      res.set('Cache-Control', 'private, no-store')
      return res.status(200).json(result)
    }).catch(next)
    return
  }

  if (progressPending.size >= PROGRESS_PENDING_LIMIT) return next()

  let release
  const pending = new Promise((resolve) => { release = resolve })
  progressPending.set(pendingKey, pending)

  let settled = false
  const finish = (result) => {
    if (settled) return
    settled = true
    if (progressPending.get(pendingKey) === pending) progressPending.delete(pendingKey)
    release(result)
  }

  const originalJson = res.json.bind(res)
  res.set('Cache-Control', 'private, no-store')
  res.json = (body) => {
    const successful = res.statusCode === 200 && body?.ok === true && Array.isArray(body.items)
    if (successful && progressCacheGeneration === generation) {
      try {
        if (Buffer.byteLength(JSON.stringify(body)) <= PROGRESS_READ_MAX_BODY_BYTES) {
          progressResponseCache.delete(key)
          progressResponseCache.set(key, {
            body,
            generation,
            expiresAt: Date.now() + PROGRESS_READ_TTL_MS,
          })
          while (progressResponseCache.size > PROGRESS_READ_MAX_ENTRIES) {
            progressResponseCache.delete(progressResponseCache.keys().next().value)
          }
        }
      } catch {
        progressResponseCache.delete(key)
      }
    }
    finish(successful && progressCacheGeneration === generation ? body : null)
    return originalJson(body)
  }

  res.once('close', () => finish(null))
  return next()
}

router.get('/', progressPreAuthLimit, traceReadingProgressRead, requireUser, progressRateLimit, coalesceProgressRead, getReadingProgress)
router.post('/', progressPreAuthLimit, traceReadingProgressSave, requireUser, progressRateLimit, invalidateProgressAfterWrite, saveReadingProgress)

export default router
