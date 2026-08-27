import express from 'express'
import {
  getAdminAuthorRanking,
  getAdminEpisodeRanking,
  getAdminGenreRanking,
  getAdminIncomeRanking,
  getAdminStoryRanking,
  getHiddenRankingItems,
  updateAuthorRankingVisibility,
  updateEpisodeRankingVisibility,
  updateStoryRankingVisibility,
} from '../controllers/adminRanking.controller.js'
import { requireAdmin } from '../middleware/auth.middleware.js'

const router = express.Router()

router.get('/stories', requireAdmin, getAdminStoryRanking)
router.get('/genres', requireAdmin, getAdminGenreRanking)
router.get('/authors', requireAdmin, getAdminAuthorRanking)
router.get('/episodes', requireAdmin, getAdminEpisodeRanking)
router.get('/income', requireAdmin, getAdminIncomeRanking)
router.get('/hidden', requireAdmin, getHiddenRankingItems)

router.patch('/stories/:storyId/visibility', requireAdmin, updateStoryRankingVisibility)
router.patch('/authors/:authorId/visibility', requireAdmin, updateAuthorRankingVisibility)
router.patch('/episodes/:episodeId/visibility', requireAdmin, updateEpisodeRankingVisibility)

export default router
