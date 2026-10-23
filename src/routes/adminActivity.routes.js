import express from 'express'
import { rateLimit } from 'express-rate-limit'
import { requireAdmin } from '../middleware/auth.middleware.js'
import { getAdminActivityLogs } from '../controllers/adminActivity.controller.js'

const router = express.Router()

const adminActivityReadLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 180,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {
    ok: false,
    code: 'ADMIN_ACTIVITY_RATE_LIMIT',
    message: 'Too many activity log requests. Please retry shortly.',
  },
})

router.get('/', requireAdmin, adminActivityReadLimit, getAdminActivityLogs)

export default router
