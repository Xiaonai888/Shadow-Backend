import express from 'express'
import { requireAdmin } from '../middleware/auth.middleware.js'
import { getAdminDiamondGifts } from '../controllers/adminDiamondGifts.controller.js'
import { getAdminAuthorPageIncome } from '../controllers/adminAuthorPageIncome.controller.js'
import { getAdminShadowMallIncome } from '../controllers/adminShadowMallIncome.controller.js'
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
router.get('/diamond-gifts', requireAdmin, getAdminDiamondGifts)
router.get('/author-page', requireAdmin, getAdminAuthorPageIncome)
router.get('/shadow-mall', requireAdmin, getAdminShadowMallIncome)
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
