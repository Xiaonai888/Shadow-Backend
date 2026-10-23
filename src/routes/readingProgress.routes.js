import { rateLimit } from 'express-rate-limit'
import express from 'express'
import {
  getReadingProgress,
  saveReadingProgress,
} from '../controllers/readingProgress.controller.js'
import { requireUser } from '../middleware/user.middleware.js'

const router = express.Router()
router.use(rateLimit({
  windowMs: 60 * 1000,
  limit: 1200,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
}))
const progressRateLimit = rateLimit({
  windowMs: 60000,
  limit: 120,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req) => `${String(req.user?.user_id || req.user?.id || 'unauthenticated')}:${req.method}`,
  message: {
    ok: false,
    code: 'READING_PROGRESS_RATE_LIMIT',
    message: 'Too many reading progress requests. Please try again shortly.',
  },
})

router.get('/', requireUser, progressRateLimit, getReadingProgress)
router.post('/', requireUser, progressRateLimit, saveReadingProgress)

export default router
