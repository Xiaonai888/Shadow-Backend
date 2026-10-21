import express from 'express'
import {
  getWriterWednesdayStatus,
  getEpisodeUnlockStatus,
  getEpisodeReadGate,
  unlockEpisodeWithDiamonds,
  unlockEpisodePackageWithDiamonds,
  unlockDiscoverSpecialPromotionWithDiamonds,
  unlockEpisodeWithGems,
  unlockEpisodeWithVoucher,
  unlockEpisodeWithStoryCard,
  unlockEpisodeWithAd,
} from '../controllers/unlocks.controller.js'
import {
  consumeRewardedAdChallenge,
  createRewardedAdChallenge,
} from '../controllers/rewardedAds.controller.js'
import {
  getAdminRewardedAdAnalytics,
  trackRewardedAdEvent,
} from '../controllers/rewardedAdAnalytics.controller.js'
import { getPlatformUnlockRules } from '../controllers/unlockRules.controller.js'
import { requireAdmin } from '../middleware/auth.middleware.js'
import { requireUser } from '../middleware/user.middleware.js'
import { loadReaderPremiumTier } from '../middleware/readerPremiumTier.middleware.js'

function logReadGateFailure(req, res, next) {
  const startedAt = Date.now()
  const originalJson = res.json.bind(res)
  res.json = (body) => {
    if (res.statusCode >= 400) {
      console.warn('READ_GATE_HTTP_ERROR', JSON.stringify({
        status: res.statusCode,
        code: String(body?.code || 'UNKNOWN'),
        message: String(body?.message || '').slice(0, 120),
        duration_ms: Date.now() - startedAt,
      }))
    }
    return originalJson(body)
  }
  next()
}

const router = express.Router()

router.get('/rules', getPlatformUnlockRules)
router.get('/events/writer-wednesday', getWriterWednesdayStatus)
router.get('/admin/rewarded-ad-analytics', requireAdmin, getAdminRewardedAdAnalytics)
router.get('/stories/:storyId/episodes/:episodeId/status', requireUser, loadReaderPremiumTier, getEpisodeUnlockStatus)
router.get('/stories/:storyId/episodes/:episodeId/read-gate', logReadGateFailure, requireUser, loadReaderPremiumTier, getEpisodeReadGate)
router.post('/stories/:storyId/episodes/:episodeId/diamond', requireUser, loadReaderPremiumTier, unlockEpisodeWithDiamonds)
router.post('/stories/:storyId/episodes/:episodeId/package', requireUser, loadReaderPremiumTier, unlockEpisodePackageWithDiamonds)
router.post('/stories/:storyId/special-promotion', requireUser, unlockDiscoverSpecialPromotionWithDiamonds)
router.post('/stories/:storyId/episodes/:episodeId/gem', requireUser, loadReaderPremiumTier, unlockEpisodeWithGems)
router.post('/stories/:storyId/episodes/:episodeId/voucher', requireUser, loadReaderPremiumTier, unlockEpisodeWithVoucher)
router.post('/stories/:storyId/episodes/:episodeId/story-card', requireUser, loadReaderPremiumTier, unlockEpisodeWithStoryCard)
router.post('/stories/:storyId/episodes/:episodeId/ad/challenge', requireUser, createRewardedAdChallenge)
router.post('/stories/:storyId/episodes/:episodeId/ad/event', requireUser, trackRewardedAdEvent)
router.post('/stories/:storyId/episodes/:episodeId/ad', requireUser, loadReaderPremiumTier, consumeRewardedAdChallenge, unlockEpisodeWithAd)

export default router
