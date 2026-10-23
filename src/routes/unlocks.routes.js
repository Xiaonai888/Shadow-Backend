import express from 'express'
import { rateLimit } from 'express-rate-limit'
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
const unlockWriteLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req) => String(req.user?.user_id || req.user?.id || 'unknown'),
  message: {
    ok: false,
    code: 'UNLOCK_RATE_LIMIT',
    message: 'Too many unlock requests. Please try again shortly.',
  },
})

  router.use(rateLimit({
  windowMs: 60000, limit: 1200, standardHeaders: 'draft-8', legacyHeaders: false,
  keyGenerator: (req) => req.spamGuard?.identity_type === 'account' ? req.spamGuard.guard_key : String(req.socket?.remoteAddress || 'unknown')
}))

router.get('/rules', getPlatformUnlockRules)
router.get('/events/writer-wednesday', getWriterWednesdayStatus)
router.get('/admin/rewarded-ad-analytics', requireAdmin, getAdminRewardedAdAnalytics)
router.get('/stories/:storyId/episodes/:episodeId/status', requireUser, loadReaderPremiumTier, getEpisodeUnlockStatus)
router.get('/stories/:storyId/episodes/:episodeId/read-gate', logReadGateFailure, requireUser, loadReaderPremiumTier, getEpisodeReadGate)
router.post('/stories/:storyId/episodes/:episodeId/diamond', requireUser, unlockWriteLimit, loadReaderPremiumTier, unlockEpisodeWithDiamonds)
router.post('/stories/:storyId/episodes/:episodeId/package', requireUser, unlockWriteLimit, loadReaderPremiumTier, unlockEpisodePackageWithDiamonds)
router.post('/stories/:storyId/special-promotion', requireUser, unlockWriteLimit, unlockDiscoverSpecialPromotionWithDiamonds)
router.post('/stories/:storyId/episodes/:episodeId/gem', requireUser, unlockWriteLimit, loadReaderPremiumTier, unlockEpisodeWithGems)
router.post('/stories/:storyId/episodes/:episodeId/voucher', requireUser, unlockWriteLimit, loadReaderPremiumTier, unlockEpisodeWithVoucher)
router.post('/stories/:storyId/episodes/:episodeId/story-card', requireUser, unlockWriteLimit, loadReaderPremiumTier, unlockEpisodeWithStoryCard)
router.post('/stories/:storyId/episodes/:episodeId/ad/challenge', requireUser, unlockWriteLimit, createRewardedAdChallenge)
router.post('/stories/:storyId/episodes/:episodeId/ad/event', requireUser, unlockWriteLimit, trackRewardedAdEvent)
router.post('/stories/:storyId/episodes/:episodeId/ad', requireUser, unlockWriteLimit, loadReaderPremiumTier, consumeRewardedAdChallenge, unlockEpisodeWithAd)

export default router
