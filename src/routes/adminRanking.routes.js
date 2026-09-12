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
import {
  getAdminRankingSettings,
  updateAdminRankingSettings,
} from '../controllers/adminRankingSettings.controller.js'
import { requireAdmin } from '../middleware/auth.middleware.js'
import { getAdminSectionRanking } from '../controllers/adminSectionRank.controller.js'
import { invalidatePublicStoriesCache } from '../services/publicStoriesResponseCache.service.js'

const router = express.Router()

function invalidatePublicStoriesAfterMutation(
  _req,
  res,
  next
) {
  res.once('finish', () => {
    if (
      res.statusCode >= 200 &&
      res.statusCode < 300
    ) {
      invalidatePublicStoriesCache()
    }
  })

  next()
}

router.get('/sections', requireAdmin, getAdminSectionRanking)
router.get('/stories', requireAdmin, getAdminStoryRanking)
router.get('/genres', requireAdmin, getAdminGenreRanking)
router.get('/authors', requireAdmin, getAdminAuthorRanking)
router.get('/episodes', requireAdmin, getAdminEpisodeRanking)
router.get('/income', requireAdmin, getAdminIncomeRanking)
router.get('/hidden', requireAdmin, getHiddenRankingItems)
router.get('/settings', requireAdmin, getAdminRankingSettings)

router.patch('/settings', requireAdmin, updateAdminRankingSettings)
router.patch(
  '/stories/:storyId/visibility',
  requireAdmin,
  invalidatePublicStoriesAfterMutation,
  updateStoryRankingVisibility
)
router.patch('/authors/:authorId/visibility', requireAdmin, updateAuthorRankingVisibility)
router.patch(
  '/episodes/:episodeId/visibility',
  requireAdmin,
  invalidatePublicStoriesAfterMutation,
  updateEpisodeRankingVisibility
)

export default router
