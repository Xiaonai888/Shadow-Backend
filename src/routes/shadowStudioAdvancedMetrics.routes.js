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
const eventLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 90,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { ok: false, code: 'STUDIO_EVENT_RATE_LIMITED', message: 'Too many analytics events.' },
})

router.get('/summary', readLimit, requireUser, getStudioAdvancedSummary)
router.post('/watch', eventLimit, requireUser, postStudioWatch)
router.post('/thumbnail', eventLimit, requireUser, postStudioThumbnail)

export default router
