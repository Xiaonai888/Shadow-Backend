import express from 'express'
import jwt from 'jsonwebtoken'
import { createHash } from 'node:crypto'
import { rateLimit } from 'express-rate-limit'
import {
  createEchoV2,
  deleteEchoV2,
  getEchoV2BySource,
  getEchoV2ByUsername,
  getEchoV2Feed,
  getEchoV2Health,
  getMyEchoV2,
  getReceivedEchoV2,
} from '../controllers/echoV2.controller.js'
import { requireUser } from '../middleware/user.middleware.js'

const router = express.Router()
const FAST_ECHO_CACHE_TTL_MS = 2500
const FAST_ECHO_CACHE_LIMIT = 200
const FAST_ECHO_PENDING_LIMIT = 100
const fastEchoCache = new Map()
const fastEchoPending = new Map()
let fastEchoGeneration = 0

const echoV2ReadLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 900,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {
    ok: false,
    code: 'ECHO_V2_READ_RATE_LIMIT',
    message: 'Too many echo requests. Please retry shortly.',
  },
})

const echoV2WriteLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {
    ok: false,
    code: 'ECHO_V2_WRITE_RATE_LIMIT',
    message: 'Too many echo actions. Please retry shortly.',
  },
})

function optionalUser(req, res, next) {
  try {
    const authHeader =
      req.headers.authorization || ''
    const token =
      authHeader.startsWith('Bearer ')
        ? authHeader.slice(7)
        : ''

    if (
      !token ||
      !process.env.JWT_SECRET
    ) {
      return next()
    }

    const decoded = jwt.verify(
      token,
      process.env.JWT_SECRET
    )

    if (decoded.type === 'reader') {
      req.user = decoded
    }

    return next()
  } catch {
    return next()
  }
}

function invalidateFastEchoCache(req, res, next) {
  res.once('finish', () => {
    if (res.statusCode >= 200 && res.statusCode < 300) {
      fastEchoGeneration += 1
      fastEchoCache.clear()
    }
  })
  return next()
}

function coalesceFastEchoSource(req, res, next) {
  if (String(req.params.sourceType || '').toLowerCase() !== 'fast_video') return next()

  const authHeader = String(req.headers.authorization || '')
  const viewerId = String(req.user?.user_id || req.user?.id || '')
  const key = createHash('sha256')
    .update(JSON.stringify([viewerId, authHeader, req.originalUrl]))
    .digest('hex')
  const generation = fastEchoGeneration
  const now = Date.now()
  const cached = fastEchoCache.get(key)

  if (cached && cached.expiresAt > now && cached.generation === generation) {
    fastEchoCache.delete(key)
    fastEchoCache.set(key, cached)
    res.set('Cache-Control', 'private, no-store')
    return res.status(200).json(cached.body)
  }
  if (cached) fastEchoCache.delete(key)

  const pendingKey = `${generation}:${key}`
  const existing = fastEchoPending.get(pendingKey)
  if (existing) {
    existing.then((result) => {
      if (res.headersSent || res.writableEnded || res.destroyed) return
      if (!result || generation !== fastEchoGeneration) return next()
      res.set('Cache-Control', 'private, no-store')
      return res.status(200).json(result)
    }).catch(next)
    return
  }

  if (fastEchoPending.size >= FAST_ECHO_PENDING_LIMIT) return next()

  let resolvePending
  const promise = new Promise((resolve) => {
    resolvePending = resolve
  })
  fastEchoPending.set(pendingKey, promise)

  let settled = false
  const finish = (value) => {
    if (settled) return
    settled = true
    if (fastEchoPending.get(pendingKey) === promise) fastEchoPending.delete(pendingKey)
    resolvePending(value)
  }

  res.set('Cache-Control', 'private, no-store')
  const originalJson = res.json.bind(res)
  res.json = (body) => {
    const success = res.statusCode === 200 && body?.ok === true
    if (success && generation === fastEchoGeneration) {
      fastEchoCache.delete(key)
      fastEchoCache.set(key, {
        body,
        generation,
        expiresAt: Date.now() + FAST_ECHO_CACHE_TTL_MS,
      })
      while (fastEchoCache.size > FAST_ECHO_CACHE_LIMIT) {
        fastEchoCache.delete(fastEchoCache.keys().next().value)
      }
    }
    finish(success && generation === fastEchoGeneration ? body : null)
    return originalJson(body)
  }

  res.once('close', () => finish(null))
  return next()
}

router.get(
  '/health',
  echoV2ReadLimit,
  getEchoV2Health
)

router.get(
  '/source/:sourceType/:sourceId',
  echoV2ReadLimit,
  optionalUser,
  coalesceFastEchoSource,
  getEchoV2BySource
)

router.get(
  '/feed',
  echoV2ReadLimit,
  requireUser,
  getEchoV2Feed
)

router.get(
  '/me',
  echoV2ReadLimit,
  requireUser,
  getMyEchoV2
)

router.get(
  '/received',
  echoV2ReadLimit,
  requireUser,
  getReceivedEchoV2
)

router.get(
  '/user/:username',
  echoV2ReadLimit,
  requireUser,
  getEchoV2ByUsername
)

router.post(
  '/',
  echoV2WriteLimit,
  requireUser,
  invalidateFastEchoCache,
  createEchoV2
)

router.delete(
  '/:echoId',
  echoV2WriteLimit,
  requireUser,
  invalidateFastEchoCache,
  deleteEchoV2
)

export default router
