import express from 'express'
import { ipKeyGenerator, rateLimit } from 'express-rate-limit'
import { requireAdmin } from '../middleware/auth.middleware.js'
import {
  listAdminAuthorAdCampaigns,
  getAdminAuthorAdSummary,
  getAdminAuthorAdCampaign,
  reviewAdminAuthorAdCampaign,
} from '../controllers/adminAuthorAds.controller.js'

const router = express.Router()

function adminRateLimitIdentity(req) {
  return String(
    req.admin?.admin_id ||
    req.admin?.id ||
    req.admin?.sub ||
    req.admin?.email ||
    ipKeyGenerator(req.ip)
  )
}

const adminAdsReadLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 90,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: adminRateLimitIdentity,
  message: {
    ok: false,
    code: 'ADMIN_AUTHOR_ADS_READ_LIMIT',
    message: 'Too many Author Ads requests. Please retry shortly.',
  },
})

const adminAdsReviewLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: adminRateLimitIdentity,
  message: {
    ok: false,
    code: 'ADMIN_AUTHOR_ADS_REVIEW_LIMIT',
    message: 'Too many campaign reviews. Please retry shortly.',
  },
})

router.use(requireAdmin)
router.use((req, res, next) => {
  res.set('Cache-Control', 'private, no-store')
  next()
})

router.get('/campaigns/summary', adminAdsReadLimit, getAdminAuthorAdSummary)
router.get('/campaigns', adminAdsReadLimit, listAdminAuthorAdCampaigns)
router.get('/campaigns/:campaignId', adminAdsReadLimit, getAdminAuthorAdCampaign)
router.post('/campaigns/:campaignId/review', adminAdsReviewLimit, reviewAdminAuthorAdCampaign)

export default router
