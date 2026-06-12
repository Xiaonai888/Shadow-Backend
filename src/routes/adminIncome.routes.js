import express from 'express'
import { requireAdmin } from '../middleware/auth.middleware.js'
import { getAdminIncomeSummary } from '../controllers/adminIncome.controller.js'

const router = express.Router()

router.get('/summary', requireAdmin, getAdminIncomeSummary)

export default router
