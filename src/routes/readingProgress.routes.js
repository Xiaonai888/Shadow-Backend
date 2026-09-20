import { createRateLimit } from '../middleware/rateLimit.middleware.js'
import express from 'express'
import {
  getReadingProgress,
  saveReadingProgress,
} from '../controllers/readingProgress.controller.js'
import { requireUser } from '../middleware/user.middleware.js'

const router = express.Router()
const progressRateLimit = createRateLimit({ key: 'reading-progress', windowMs: 60000, max: 120, identity: (req) => req.user?.user_id })

router.get('/', requireUser, progressRateLimit, getReadingProgress)
router.post('/', requireUser, progressRateLimit, saveReadingProgress)

export default router
