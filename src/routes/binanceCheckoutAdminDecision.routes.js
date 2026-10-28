import express from 'express'
import { rateLimit, ipKeyGenerator } from 'express-rate-limit'
import { requireAdmin } from '../middleware/auth.middleware.js'
import {
  approveAdminBinanceCheckout,
  rejectAdminBinanceCheckout,
  linkAdminBinanceCheckoutReceipt,
} from '../controllers/binanceCheckoutAdminDecision.controller.js'

const router = express.Router()
const ipLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
})
const adminLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: req => String(req.admin?.admin_id || req.admin?.id || ipKeyGenerator(req.ip)),
})

router.post('/checkout-reviews/:orderId/link-receipt', ipLimit, requireAdmin, adminLimit, linkAdminBinanceCheckoutReceipt)
router.post('/checkout-reviews/:orderId/approve', ipLimit, requireAdmin, adminLimit, approveAdminBinanceCheckout)
router.post('/checkout-reviews/:orderId/reject', ipLimit, requireAdmin, adminLimit, rejectAdminBinanceCheckout)

export default router
