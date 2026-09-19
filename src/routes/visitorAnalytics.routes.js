import express from 'express'
import { trackAnonymousVisitor } from '../controllers/visitorAnalytics.controller.js'
import { trackStorySectionRankEvent } from '../controllers/storySectionRank.controller.js'
import { createRateLimit } from '../middleware/rateLimit.middleware.js'

const router = express.Router()
const storySectionRankRateLimit = createRateLimit({
  key: 'visitor-story-section-rank',
  windowMs: 60 * 1000,
  max: 120,
  message: 'Too many ranking events. Please try again later.',
})

router.post('/track', trackAnonymousVisitor)
router.post('/story-section-rank', storySectionRankRateLimit, trackStorySectionRankEvent)

export default router
