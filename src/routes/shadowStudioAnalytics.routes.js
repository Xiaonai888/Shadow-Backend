import { Router } from 'express'
import { rateLimit } from 'express-rate-limit'
import { requireUser } from '../middleware/user.middleware.js'
import {
  getStudioDashboard,
  getStudioRanking,
  getStudioVideoAnalytics,
} from '../controllers/shadowStudioAnalytics.controller.js'

const router = Router()
const readLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { ok: false, code: 'STUDIO_RATE_LIMITED', message: 'Too many Studio analytics requests.' },
})

router.get('/dashboard', readLimit, requireUser, getStudioDashboard)
router.get('/ranking', readLimit, requireUser, getStudioRanking)
router.get('/videos/:videoId', readLimit, requireUser, getStudioVideoAnalytics)

export default router
