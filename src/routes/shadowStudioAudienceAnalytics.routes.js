import { Router } from 'express'
import { rateLimit } from 'express-rate-limit'
import { requireUser } from '../middleware/user.middleware.js'
import { getStudioAudienceSummary } from '../controllers/shadowStudioAudienceAnalytics.controller.js'

const router = Router()
const readLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { ok: false, code: 'STUDIO_RATE_LIMITED', message: 'Too many audience analytics requests.' },
})

router.get('/summary', readLimit, requireUser, getStudioAudienceSummary)

export default router
