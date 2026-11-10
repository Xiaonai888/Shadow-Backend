import { Router } from 'express'
import { rateLimit } from 'express-rate-limit'
import { requireUser } from '../middleware/user.middleware.js'
import {
  getStudioChannelContent,
  getStudioChannelOverview,
} from '../controllers/shadowStudioChannelAnalytics.controller.js'

const router = Router()
const readLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { ok: false, code: 'STUDIO_RATE_LIMITED', message: 'Too many Studio analytics requests.' },
})

router.get('/overview', readLimit, requireUser, getStudioChannelOverview)
router.get('/content', readLimit, requireUser, getStudioChannelContent)

export default router
