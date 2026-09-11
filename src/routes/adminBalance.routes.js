import express from 'express'
import { requireAdmin } from '../middleware/auth.middleware.js'
import { createSpamGuard } from '../middleware/spamGuard.middleware.js'
import {
  getAdminBalanceDiamondHistory,
  getAdminBalanceWallets,
} from '../controllers/adminBalance.controller.js'
import { getAdminBalanceSpendSummary } from '../controllers/adminBalanceSpendSummary.controller.js'

const router = express.Router()

const adminBalanceReadGuard = createSpamGuard({
  scope: 'admin_balance_read',
  threshold: 60,
  windowSeconds: 60,
})

router.get(
  '/',
  requireAdmin,
  adminBalanceReadGuard,
  getAdminBalanceWallets
)

router.get(
  '/:userId/diamond-history',
  requireAdmin,
  adminBalanceReadGuard,
  getAdminBalanceDiamondHistory
)

router.get(
  '/:userId/spend-summary',
  requireAdmin,
  adminBalanceReadGuard,
  getAdminBalanceSpendSummary
)

export default router
