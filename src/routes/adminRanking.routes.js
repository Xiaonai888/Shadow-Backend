import express from 'express'
import {
  getAdminStoryRanking,
  getHiddenRankingItems,
  updateStoryRankingVisibility,
} from '../controllers/adminRanking.controller.js'
import { requireAdmin } from '../middleware/auth.middleware.js'

const router = express.Router()

router.get('/stories', requireAdmin, getAdminStoryRanking)
router.get('/hidden', requireAdmin, getHiddenRankingItems)
router.patch('/stories/:storyId/visibility', requireAdmin, updateStoryRankingVisibility)

export default router
