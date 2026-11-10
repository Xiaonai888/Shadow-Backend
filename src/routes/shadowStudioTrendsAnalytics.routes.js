import { Router } from 'express'
import { rateLimit } from 'express-rate-limit'
import { requireUser } from '../middleware/user.middleware.js'
import {
  getStudioTrends,
  saveStudioTrendTopic,
  removeStudioTrendTopic,
} from '../controllers/shadowStudioTrendsAnalytics.controller.js'

const router = Router()
const readLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { ok: false, code: 'STUDIO_TRENDS_RATE_LIMITED', message: 'Too many trends requests.' },
})
const writeLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 15,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { ok: false, code: 'STUDIO_TRENDS_RATE_LIMITED', message: 'Too many topic changes.' },
})

router.get('/summary', readLimit, requireUser, getStudioTrends)
router.post('/saved-topics', writeLimit, requireUser, saveStudioTrendTopic)
router.delete('/saved-topics', writeLimit, requireUser, removeStudioTrendTopic)

export default router
