import { Router } from 'express'
import { rateLimit } from 'express-rate-limit'
import { requireUser } from '../middleware/user.middleware.js'
import {
  getStudioAdvancedSummary,
  postStudioThumbnail,
  postStudioWatch,
} from '../controllers/shadowStudioAdvancedMetrics.controller.js'

const router = Router()

const readLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { ok: false, code: 'STUDIO_RATE_LIMITED', message: 'Too many analytics requests.' },
})

const eventNetworkSafetyLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 2000,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { ok: false, code: 'STUDIO_NETWORK_SAFETY_LIMIT', message: 'Too many Studio events from this network.' },
})

const eventLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 90,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => `studio-reader:${String(req.user?.user_id || 'unknown')}`,
  message: { ok: false, code: 'STUDIO_EVENT_RATE_LIMITED', message: 'Too many analytics events.' },
})

router.get('/summary', readLimit, requireUser, getStudioAdvancedSummary)
router.post('/watch', eventNetworkSafetyLimit, requireUser, eventLimit, postStudioWatch)
router.post('/thumbnail', eventNetworkSafetyLimit, requireUser, eventLimit, postStudioThumbnail)

export default router
