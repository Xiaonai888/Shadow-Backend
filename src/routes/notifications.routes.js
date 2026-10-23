import express from 'express'
import { rateLimit, ipKeyGenerator } from 'express-rate-limit'
import {
  getMyNotificationUnreadCount,
  getMyNotifications,
  markAllNotificationsAsRead,
  markNotificationAsRead,
} from '../controllers/notifications.controller.js'
import { requireUser } from '../middleware/user.middleware.js'

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

router.get('/', notificationReadLimit, requireUser, getMyNotifications)
router.get('/unread-count', notificationReadLimit, requireUser, getMyNotificationUnreadCount)
router.patch('/read-all', notificationWriteLimit, requireUser, markAllNotificationsAsRead)
router.patch('/:notificationId/read', notificationWriteLimit, requireUser, markNotificationAsRead)

export default router
