import express from 'express'
import { ipKeyGenerator, rateLimit } from 'express-rate-limit'
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

const adminRankingIdentity = (req) => String(
  req.admin?.admin_id ||
  req.admin?.id ||
  req.admin?.sub ||
  req.admin?.email ||
  ipKeyGenerator(req.ip)
)

const adminRankingReadLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 240,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: adminRankingIdentity,
  message: {
    ok: false,
    code: 'ADMIN_RANKING_READ_RATE_LIMIT',
    message: 'Too many ranking requests. Please retry shortly.',
  },
})

const adminRankingWriteLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: adminRankingIdentity,
  message: {
    ok: false,
    code: 'ADMIN_RANKING_WRITE_RATE_LIMIT',
    message: 'Too many ranking changes. Please retry shortly.',
  },
})

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

router.get('/sections', requireAdmin, adminRankingReadLimit, getAdminSectionRanking)
router.get('/stories', requireAdmin, adminRankingReadLimit, getAdminStoryRanking)
router.get('/genres', requireAdmin, adminRankingReadLimit, getAdminGenreRanking)
router.get('/authors', requireAdmin, adminRankingReadLimit, getAdminAuthorRanking)
router.get('/episodes', requireAdmin, adminRankingReadLimit, getAdminEpisodeRanking)
router.get('/income', requireAdmin, adminRankingReadLimit, getAdminIncomeRanking)
router.get('/hidden', requireAdmin, adminRankingReadLimit, getHiddenRankingItems)
router.get('/settings', requireAdmin, adminRankingReadLimit, getAdminRankingSettings)

router.patch('/settings', requireAdmin, adminRankingWriteLimit, updateAdminRankingSettings)
router.patch(
  '/stories/:storyId/visibility',
  requireAdmin,
  adminRankingWriteLimit,
  invalidatePublicStoriesAfterMutation,
  updateStoryRankingVisibility
)
router.patch('/authors/:authorId/visibility', requireAdmin, adminRankingWriteLimit, updateAuthorRankingVisibility)
router.patch(
  '/episodes/:episodeId/visibility',
  requireAdmin,
  adminRankingWriteLimit,
  invalidatePublicStoriesAfterMutation,
  updateEpisodeRankingVisibility
)

export default router
