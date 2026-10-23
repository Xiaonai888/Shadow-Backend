import express from 'express'
import { rateLimit } from 'express-rate-limit'
import { requireAdmin } from '../middleware/auth.middleware.js'
import { createSpamGuard } from '../middleware/spamGuard.middleware.js'
import {
  getAdminBalanceDiamondHistory,
  getAdminBalanceWallets,
} from '../controllers/adminBalance.controller.js'
import { getAdminBalanceSpendSummary } from '../controllers/adminBalanceSpendSummary.controller.js'

const router = express.Router()

const adminBalanceRateLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 600,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {
    ok: false,
    code: 'ADMIN_BALANCE_RATE_LIMIT',
    message: 'Too many balance requests. Please retry shortly.',
  },
})

const adminBalanceReadGuard = createSpamGuard({
  scope: 'admin_balance_read',
  threshold: 60,
  windowSeconds: 60,
})

router.get(
  '/',
  adminBalanceRateLimit,
  requireAdmin,
  adminBalanceReadGuard,
  getAdminBalanceWallets
)

router.get(
  '/:userId/diamond-history',
  adminBalanceRateLimit,
  requireAdmin,
  adminBalanceReadGuard,
  getAdminBalanceDiamondHistory
)

router.get(
  '/:userId/spend-summary',
  adminBalanceRateLimit,
  requireAdmin,
  adminBalanceReadGuard,
  getAdminBalanceSpendSummary
)

export default router
