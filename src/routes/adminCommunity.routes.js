import express from 'express'
import { ipKeyGenerator, rateLimit } from 'express-rate-limit'
import {
  getAdminCommunityAuthors,
  getAdminCommunityOverview,
  getAdminCommunityReaders,
  getAdminCommunityReaderDetail,
  getAdminCommunityReadersToday,
  getAdminReaderPresence,
  getAdminCommunityVisitorOverview,
  getAdminCommunityVisitors,
  getAdminCommunityVisitorDetail,
  getAdminReaderCountryAnalytics,
  getAdminReaderCountryReaders,
  getAdminDashboardGrowth,
  getAdminDashboardPaidOrders,
} from '../controllers/adminCommunity.controller.js'
import { requireAdmin } from '../middleware/auth.middleware.js'
import { requireAdminPermission } from '../middleware/adminPermission.middleware.js'
import { getAdminReaderGrowthDaily } from '../controllers/adminReaderGrowth.controller.js'
import { getAdminVisitorGrowthDaily } from '../controllers/adminVisitorGrowth.controller.js'
import { getAdminDailyReaders } from '../controllers/adminDailyReaders.controller.js'
import { getAdminReaderRanking } from '../controllers/adminReaderRanking.controller.js'
import { getAdminReaderPeriod } from '../controllers/adminReaderPeriod.controller.js'
import { getAdminReaderPeriodDetail } from '../controllers/adminReaderPeriodDetail.controller.js'

const router = express.Router()

const adminCommunityReadLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 600,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req) => String(
    req.admin?.admin_id || req.admin?.id || req.admin?.sub ||
    req.admin?.email || ipKeyGenerator(req.ip)
  ),
  message: {
    ok: false,
    code: 'ADMIN_COMMUNITY_READ_RATE_LIMIT',
    message: 'Too many community requests. Please retry shortly.',
  },
})

router.get('/overview', requireAdminPermission('community.view'), adminCommunityReadLimit, getAdminCommunityOverview)
router.get('/readers', requireAdminPermission('community.view'), adminCommunityReadLimit, getAdminCommunityReaders)
router.get('/readers/today', requireAdminPermission('readers.view'), adminCommunityReadLimit, getAdminCommunityReadersToday)
router.get('/readers/daily', requireAdminPermission('readers.view'), adminCommunityReadLimit, getAdminDailyReaders)
router.get('/readers/ranking', requireAdminPermission('readers.view'), adminCommunityReadLimit, getAdminReaderRanking)
router.get('/readers/period', requireAdminPermission('readers.view'), adminCommunityReadLimit, getAdminReaderPeriod)
router.get('/readers/period/detail', requireAdminPermission('readers.view'), adminCommunityReadLimit, getAdminReaderPeriodDetail)
router.get('/readers/:readerId', requireAdminPermission('community.view'), adminCommunityReadLimit, getAdminCommunityReaderDetail)
router.get('/reader-presence', requireAdmin, adminCommunityReadLimit, getAdminReaderPresence)
router.get('/reader-countries', requireAdminPermission('community.view'), adminCommunityReadLimit, getAdminReaderCountryAnalytics)
router.get('/reader-growth/daily', requireAdminPermission('community.view'), adminCommunityReadLimit, getAdminReaderGrowthDaily)
router.get('/visitor-growth/daily', requireAdminPermission('community.view'), adminCommunityReadLimit, getAdminVisitorGrowthDaily)
router.get('/reader-countries/:countryCode/readers', requireAdminPermission('community.view'), adminCommunityReadLimit, getAdminReaderCountryReaders)
router.get('/authors', requireAdminPermission('community.view'), adminCommunityReadLimit, getAdminCommunityAuthors)
router.get('/visitors/overview', requireAdminPermission('community.view'), adminCommunityReadLimit, getAdminCommunityVisitorOverview)
router.get('/visitors', requireAdminPermission('community.view'), adminCommunityReadLimit, getAdminCommunityVisitors)
router.get('/visitors/:visitorId', requireAdminPermission('community.view'), adminCommunityReadLimit, getAdminCommunityVisitorDetail)
router.get('/dashboard/growth', requireAdmin, adminCommunityReadLimit, getAdminDashboardGrowth)
router.get('/dashboard/orders', requireAdmin, adminCommunityReadLimit, getAdminDashboardPaidOrders)

export default router
