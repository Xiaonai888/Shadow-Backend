import express from 'express'
import {
  getAdminCommunityAuthors,
  getAdminCommunityOverview,
  getAdminCommunityReaders,
  getAdminCommunityVisitorOverview,
  getAdminCommunityVisitors,
} from '../controllers/adminCommunity.controller.js'
import { requireAdmin } from '../middleware/auth.middleware.js'

const router = express.Router()

router.get('/overview', requireAdmin, getAdminCommunityOverview)
router.get('/readers', requireAdmin, getAdminCommunityReaders)
router.get('/authors', requireAdmin, getAdminCommunityAuthors)
router.get('/visitors/overview', requireAdmin, getAdminCommunityVisitorOverview)
router.get('/visitors', requireAdmin, getAdminCommunityVisitors)

export default router
