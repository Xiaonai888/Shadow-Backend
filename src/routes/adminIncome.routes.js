import express from 'express'
import { requireAdmin } from '../middleware/auth.middleware.js'
import {
  generateAdminAuthorPayouts,
  getAdminAuthorPayouts,
  getAdminEpisodeSales,
  getAdminIncomeSummary,
  markAdminAuthorPayoutPaid,
} from '../controllers/adminIncome.controller.js'

const router = express.Router()

router.get('/summary', requireAdmin, getAdminIncomeSummary)
router.get('/episode-sales', requireAdmin, getAdminEpisodeSales)
router.get('/payouts', requireAdmin, getAdminAuthorPayouts)
router.post(
  '/payouts/generate',
  requireAdmin,
  generateAdminAuthorPayouts
)
router.post(
  '/payouts/:id/paid',
  requireAdmin,
  markAdminAuthorPayoutPaid
)

export default router
