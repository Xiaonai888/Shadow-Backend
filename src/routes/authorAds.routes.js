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

const campaignIpLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 600,
  standardHeaders: false,
  legacyHeaders: false,
  message: {
    ok: false,
    code: 'AUTHOR_ADS_IP_RATE_LIMITED',
    message: 'Too many campaign requests. Please try again shortly.',
  },
})

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

function privateNoStore(req, res, next) {
  res.set('Cache-Control', 'private, no-store')
  next()
}

router.get('/me/campaigns', campaignIpLimiter, requireUser, privateNoStore, campaignReadLimiter, listMyAuthorAdCampaigns)
router.get('/me/campaigns/:campaignId', campaignIpLimiter, requireUser, privateNoStore, campaignReadLimiter, getMyAuthorAdCampaign)
router.post('/me/campaigns', campaignIpLimiter, requireUser, privateNoStore, campaignWriteLimiter, createMyAuthorAdDraft)
router.put('/me/campaigns/:campaignId', campaignIpLimiter, requireUser, privateNoStore, campaignWriteLimiter, updateMyAuthorAdDraft)
router.delete('/me/campaigns/:campaignId', campaignIpLimiter, requireUser, privateNoStore, campaignWriteLimiter, deleteMyAuthorAdDraft)
router.post('/me/campaigns/:campaignId/submit', campaignIpLimiter, requireUser, privateNoStore, campaignWriteLimiter, submitMyAuthorAdForReview)

export default router
