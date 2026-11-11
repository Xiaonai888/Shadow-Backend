import express from 'express'
import { requireUser } from '../middleware/user.middleware.js'
import { createRateLimit } from '../middleware/rateLimit.middleware.js'
import { runShadowDocsReviewAI } from '../controllers/shadowDocsReviewAI.controller.js'

const router = express.Router()
const ipLimit = createRateLimit({ key: 'shadow-docs-review-ai-ip', windowMs: 60000, max: 12 })
const userLimit = createRateLimit({ key: 'shadow-docs-review-ai-user', windowMs: 3600000, max: 20, identity: req => req.user?.user_id })

router.post('/run', ipLimit, requireUser, userLimit, runShadowDocsReviewAI)

export default router
