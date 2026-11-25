import express from 'express'
import { rateLimit } from 'express-rate-limit'
import { requireAdminPermission } from '../middleware/adminPermission.middleware.js'
import { streamAdminSupportNotifications } from '../controllers/adminSupportNotificationStream.controller.js'

const router = express.Router()
const preAuthLimit = rateLimit({
  windowMs: 60000,
  limit: 30,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { ok: false, code: 'ADMIN_SUPPORT_STREAM_IP_LIMIT', message: 'Too many requests' },
})
const identityLimit = rateLimit({
  windowMs: 60000,
  limit: 12,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: req => String(req.admin.admin_id),
  message: { ok: false, code: 'ADMIN_SUPPORT_STREAM_ADMIN_LIMIT', message: 'Too many connections' },
})

router.get('/notifications/stream', preAuthLimit, requireAdminPermission('admin_chat.view'), identityLimit, streamAdminSupportNotifications)

export default router
