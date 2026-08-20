import express from 'express'
import {
  getAdminCommunityAuthors,
  getAdminCommunityOverview,
  getAdminCommunityReaders,
  getAdminCommunityReadersToday,
  getAdminReaderPresence,
  getAdminCommunityVisitorOverview,
  getAdminCommunityVisitors,
  getAdminDashboardGrowth,
  getAdminDashboardPaidOrders,
} from '../controllers/adminCommunity.controller.js'
import { requireAdmin } from '../middleware/auth.middleware.js'
import { requireAdminPermission } from '../middleware/adminPermission.middleware.js'

const router = express.Router()

router.get('/overview', requireAdminPermission('community.view'), getAdminCommunityOverview)
router.get('/readers', requireAdminPermission('community.view'), getAdminCommunityReaders)
router.get('/readers/today', requireAdminPermission('readers.view'), getAdminCommunityReadersToday)
router.get('/reader-presence', requireAdmin, getAdminReaderPresence)
router.get('/authors', requireAdminPermission('community.view'), getAdminCommunityAuthors)
router.get('/visitors/overview', requireAdminPermission('community.view'), getAdminCommunityVisitorOverview)
router.get('/visitors', requireAdminPermission('community.view'), getAdminCommunityVisitors)
router.get('/dashboard/growth', requireAdmin, getAdminDashboardGrowth)
router.get('/dashboard/orders', requireAdmin, getAdminDashboardPaidOrders)

export default router
