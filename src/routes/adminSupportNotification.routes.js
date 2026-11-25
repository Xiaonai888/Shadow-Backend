import express from 'express'
import { rateLimit } from 'express-rate-limit'
import { requireAdminPermission } from '../middleware/adminPermission.middleware.js'
import { getAdminSupportNotificationCount, listAdminSupportNotifications } from '../controllers/adminSupportNotification.controller.js'

const router = express.Router()
const preAuthLimit = rateLimit({
  windowMs: 60_000,
  limit: 60,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { ok: false, code: 'ADMIN_SUPPORT_NOTIFICATION_IP_LIMIT', message: 'Too many requests' },
})
const readLimit = rateLimit({
  windowMs: 60_000,
  limit: 30,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: req => String(req.admin.admin_id),
  message: { ok: false, code: 'ADMIN_SUPPORT_NOTIFICATION_READ_LIMIT', message: 'Too many requests' },
})
const viewChat = requireAdminPermission('admin_chat.view')

router.get('/notifications/count', preAuthLimit, viewChat, readLimit, getAdminSupportNotificationCount)
router.get('/notifications', preAuthLimit, viewChat, readLimit, listAdminSupportNotifications)

export default router
