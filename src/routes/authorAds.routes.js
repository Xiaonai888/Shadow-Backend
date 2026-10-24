import express from 'express'
import { ipKeyGenerator, rateLimit } from 'express-rate-limit'
import { requireUser } from '../middleware/user.middleware.js'
import {
  listMyAuthorAdCampaigns,
  getMyAuthorAdCampaign,
  createMyAuthorAdDraft,
  updateMyAuthorAdDraft,
  deleteMyAuthorAdDraft,
  submitMyAuthorAdForReview,
} from '../controllers/authorAds.controller.js'

const router = express.Router()

const campaignReadLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 240,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req) => String(
    req.user?.user_id ||
    ipKeyGenerator(req.ip)
  ),
  message: {
    ok: false,
    code: 'AUTHOR_ADS_READ_RATE_LIMITED',
    message: 'Too many campaign requests. Please try again shortly.',
  },
})

const campaignWriteLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {
    ok: false,
    code: 'AUTHOR_ADS_RATE_LIMITED',
    message: 'Too many campaign changes. Please try again shortly.',
  },
})

router.use(requireUser)
router.use((req, res, next) => {
  res.set('Cache-Control', 'private, no-store')
  next()
})

router.get('/me/campaigns', campaignReadLimiter, listMyAuthorAdCampaigns)
router.get('/me/campaigns/:campaignId', campaignReadLimiter, getMyAuthorAdCampaign)
router.post('/me/campaigns', campaignWriteLimiter, createMyAuthorAdDraft)
router.put('/me/campaigns/:campaignId', campaignWriteLimiter, updateMyAuthorAdDraft)
router.delete('/me/campaigns/:campaignId', campaignWriteLimiter, deleteMyAuthorAdDraft)
router.post('/me/campaigns/:campaignId/submit', campaignWriteLimiter, submitMyAuthorAdForReview)

export default router
