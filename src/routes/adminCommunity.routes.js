import express from 'express'
import {
  getAdminCommunityAuthors,
  getAdminCommunityOverview,
  getAdminCommunityReaders,
} from '../controllers/adminCommunity.controller.js'
import { requireAdmin } from '../middleware/auth.middleware.js'

const router = express.Router()

router.get('/overview', requireAdmin, getAdminCommunityOverview)
router.get('/readers', requireAdmin, getAdminCommunityReaders)
router.get('/authors', requireAdmin, getAdminCommunityAuthors)

export default router
