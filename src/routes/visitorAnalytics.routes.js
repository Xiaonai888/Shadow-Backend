import express from 'express'
import { trackAnonymousVisitor } from '../controllers/visitorAnalytics.controller.js'
import { trackStorySectionRankEvent } from '../controllers/storySectionRank.controller.js'

const router = express.Router()

router.post('/track', trackAnonymousVisitor)
router.post('/story-section-rank', trackStorySectionRankEvent)

export default router
