import express from 'express'
import { rateLimit, ipKeyGenerator } from 'express-rate-limit'
import { requireAdmin } from '../middleware/auth.middleware.js'
import {
  getAdminBinanceCheckoutReview,
  listAdminBinanceCheckoutReviews,
} from '../controllers/binanceCheckoutAdminReview.controller.js'

const router = express.Router()
const preAuthLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 50,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { ok: false, code: 'BINANCE_REVIEW_IP_LIMIT', message: 'Too many requests. Please retry shortly.' },
})
const accountLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: req => String(req.admin?.admin_id || req.admin?.id || ipKeyGenerator(req.ip)),
  message: { ok: false, code: 'BINANCE_REVIEW_ACCOUNT_LIMIT', message: 'Too many review requests. Please retry shortly.' },
})

router.get('/checkout-reviews', preAuthLimit, requireAdmin, accountLimit, listAdminBinanceCheckoutReviews)
router.get('/checkout-reviews/:orderId', preAuthLimit, requireAdmin, accountLimit, getAdminBinanceCheckoutReview)

export default router
