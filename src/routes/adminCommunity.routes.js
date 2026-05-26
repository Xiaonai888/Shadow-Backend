import express from 'express'
import { getAdminCommunityReaders } from '../controllers/adminCommunity.controller.js'
import { requireAdmin } from '../middleware/auth.middleware.js'

const router = express.Router()

router.get('/readers', requireAdmin, getAdminCommunityReaders)

export default router
