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

const adminAdsIpLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 600,
  standardHeaders: false,
  legacyHeaders: false,
  message: {
    ok: false,
    code: 'ADMIN_AUTHOR_ADS_IP_LIMIT',
    message: 'Too many Author Ads requests. Please retry shortly.',
  },
})

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

function noStore(req, res, next) {
  res.set('Cache-Control', 'private, no-store')
  next()
}

router.get('/campaigns/summary', adminAdsIpLimit, requireAdmin, noStore, adminAdsReadLimit, getAdminAuthorAdSummary)
router.get('/campaigns', adminAdsIpLimit, requireAdmin, noStore, adminAdsReadLimit, listAdminAuthorAdCampaigns)
router.get('/campaigns/:campaignId', adminAdsIpLimit, requireAdmin, noStore, adminAdsReadLimit, getAdminAuthorAdCampaign)
router.post('/campaigns/:campaignId/review', adminAdsIpLimit, requireAdmin, noStore, adminAdsReviewLimit, reviewAdminAuthorAdCampaign)

export default router
