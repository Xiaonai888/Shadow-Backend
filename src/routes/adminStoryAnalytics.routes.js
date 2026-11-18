import express from 'express'
import { rateLimit } from 'express-rate-limit'
import { requireAdminPermission } from '../middleware/adminPermission.middleware.js'
import {
  getAdminStoryAnalyticsController,
  searchAdminStoryAnalyticsController,
} from '../controllers/adminStoryAnalytics.controller.js'

const router = express.Router()

const ipLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {
    ok: false,
    code: 'STORY_ANALYTICS_RATE_LIMIT',
    message: 'Too many story analytics requests. Please retry shortly.',
  },
})

router.get('/search', ipLimit, requireAdminPermission('readers.view'), searchAdminStoryAnalyticsController)
router.get('/', ipLimit, requireAdminPermission('readers.view'), getAdminStoryAnalyticsController)

export default router
