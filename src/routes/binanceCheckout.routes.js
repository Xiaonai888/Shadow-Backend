import express from 'express'
import { rateLimit } from 'express-rate-limit'
import { requireUser } from '../middleware/user.middleware.js'
import { requirePaymentCountry } from '../middleware/paymentCountryGate.middleware.js'
import {
  createBinanceCheckout,
  getBinanceCheckout,
  cancelBinanceCheckout,
} from '../controllers/binanceCheckout.controller.js'

const router = express.Router()
const ipLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 40,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { ok: false, code: 'BINANCE_CHECKOUT_RATE_LIMIT', message: 'Too many requests. Please try again shortly.' },
})
const readLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req) => String(req.user?.user_id || req.user?.id),
})
const writeLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 8,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req) => String(req.user?.user_id || req.user?.id),
})

router.post('/checkout', ipLimit, requireUser, writeLimit, requirePaymentCountry('binancePay'), createBinanceCheckout)
router.get('/checkout/:orderId', ipLimit, requireUser, readLimit, getBinanceCheckout)
router.post('/checkout/:orderId/cancel', ipLimit, requireUser, writeLimit, cancelBinanceCheckout)

export default router
