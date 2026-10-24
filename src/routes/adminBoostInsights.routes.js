import express from 'express'
import { requireAdmin } from '../middleware/auth.middleware.js'
import { getAdminBoostInsights } from '../controllers/adminBoostInsights.controller.js'

const router = express.Router()

router.get('/insights', requireAdmin, getAdminBoostInsights)

export default router
