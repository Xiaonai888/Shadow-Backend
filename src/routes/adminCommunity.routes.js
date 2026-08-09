import express from 'express'
import {
  getAdminCommunityAuthors,
  getAdminCommunityOverview,
  getAdminCommunityReaders,
  getAdminCommunityReadersToday,
  getAdminCommunityVisitorOverview,
  getAdminCommunityVisitors,
  getAdminDashboardGrowth,
  getAdminDashboardPaidOrders,
} from '../controllers/adminCommunity.controller.js'
import { requireAdmin } from '../middleware/auth.middleware.js'

const router = express.Router()

router.get('/overview', requireAdmin, getAdminCommunityOverview)
router.get('/readers', requireAdmin, getAdminCommunityReaders)
router.get('/readers/today', requireAdmin, getAdminCommunityReadersToday)
router.get('/authors', requireAdmin, getAdminCommunityAuthors)
router.get('/visitors/overview', requireAdmin, getAdminCommunityVisitorOverview)
router.get('/visitors', requireAdmin, getAdminCommunityVisitors)
router.get('/dashboard/growth', requireAdmin, getAdminDashboardGrowth)
router.get('/dashboard/orders', requireAdmin, getAdminDashboardPaidOrders)

export default router
