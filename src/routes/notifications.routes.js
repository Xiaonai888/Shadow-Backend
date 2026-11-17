import express from 'express'
import { rateLimit, ipKeyGenerator } from 'express-rate-limit'
import {
  getMyNotificationUnreadCount,
  getMyNotifications,
  markAllNotificationsAsRead,
  markNotificationAsRead,
} from '../controllers/notifications.controller.js'
import { requireUser } from '../middleware/user.middleware.js'
import { getMyMassMentionDigest } from '../controllers/massMentionDigest.controller.js'

const router = express.Router()

const notificationRateLimitKey = (req) =>
  req.spamGuard?.identity_type === 'account' && req.spamGuard.guard_key
    ? req.spamGuard.guard_key
    : ipKeyGenerator(req.ip)

const notificationReadLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 900,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: notificationRateLimitKey,
  message: {
    ok: false,
    code: 'NOTIFICATION_READ_RATE_LIMIT',
    message: 'Too many notification requests. Please retry shortly.',
  },
})

const notificationWriteLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 150,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: notificationRateLimitKey,
  message: {
    ok: false,
    code: 'NOTIFICATION_WRITE_RATE_LIMIT',
    message: 'Too many notification actions. Please retry shortly.',
  },
})

const UNREAD_TTL_MS = 2000
const UNREAD_CACHE_LIMIT = 512
const UNREAD_PENDING_LIMIT = 256
const unreadCountCache = new Map()
const unreadCountPending = new Map()
let unreadGeneration = 0

function coalesceUnreadCount(req, res, next) {
  const userId = String(req.user?.user_id || '').trim()
  if (!userId) return next()

  const generation = unreadGeneration
  const key = `${generation}:${userId}`
  const cached = unreadCountCache.get(key)

  if (cached && cached.expiresAt > Date.now()) {
    unreadCountCache.delete(key)
    unreadCountCache.set(key, cached)
    res.set('Cache-Control', 'private, no-store')
    return res.status(200).json(cached.body)
  }
  if (cached) unreadCountCache.delete(key)

  const active = unreadCountPending.get(key)
  if (active) {
    active.then((result) => {
      if (res.headersSent || res.writableEnded || res.destroyed) return
      if (!result) return next()
      res.set('Cache-Control', 'private, no-store')
      res.status(result.status).json(result.body)
    }).catch(next)
    return
  }

  if (unreadCountPending.size >= UNREAD_PENDING_LIMIT) return next()

  let resolvePending
  const pending = new Promise((resolve) => {
    resolvePending = resolve
  })
  unreadCountPending.set(key, pending)

  let settled = false
  const settle = (result) => {
    if (settled) return
    settled = true
    if (unreadCountPending.get(key) === pending) {
      unreadCountPending.delete(key)
    }
    resolvePending(result)
  }

  const originalJson = res.json.bind(res)
  res.json = (body) => {
    const status = Number(res.statusCode || 200)
    if (
      status === 200 &&
      body?.ok === true &&
      Number.isFinite(Number(body.unread_count)) &&
      generation === unreadGeneration
    ) {
      unreadCountCache.delete(key)
      unreadCountCache.set(key, {
        body,
        expiresAt: Date.now() + UNREAD_TTL_MS,
      })
      while (unreadCountCache.size > UNREAD_CACHE_LIMIT) {
        unreadCountCache.delete(unreadCountCache.keys().next().value)
      }
    }
    settle({ status, body })
    res.set('Cache-Control', 'private, no-store')
    return originalJson(body)
  }

  res.once('close', () => settle(null))
  next()
}

function invalidateUnreadCountAfterWrite(req, res, next) {
  res.once('finish', () => {
    if (res.statusCode >= 200 && res.statusCode < 300) {
      unreadGeneration += 1
      unreadCountCache.clear()
    }
  })
  next()
}

router.get('/', notificationReadLimit, requireUser, getMyNotifications)
router.get('/unread-count', notificationReadLimit, requireUser, coalesceUnreadCount, getMyNotificationUnreadCount)
router.get('/mass-mentions/:digestId', notificationReadLimit, requireUser, getMyMassMentionDigest)
router.patch('/read-all', notificationWriteLimit, requireUser, invalidateUnreadCountAfterWrite, markAllNotificationsAsRead)
router.patch('/:notificationId/read', notificationWriteLimit, requireUser, invalidateUnreadCountAfterWrite, markNotificationAsRead)

export default router
