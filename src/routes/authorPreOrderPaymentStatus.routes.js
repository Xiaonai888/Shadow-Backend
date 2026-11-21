import express from 'express'
import { ipKeyGenerator, rateLimit } from 'express-rate-limit'
import { requireUser } from '../middleware/user.middleware.js'
import {
  getReaderPreOrderPaymentCapabilities,
  getReaderPreOrderOrderStatus,
  getReaderPreOrderMyOrders,
} from '../controllers/authorPreOrderPaymentStatus.controller.js'

const router = express.Router()

const ipStatusLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 180,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {
    ok: false,
    code: 'PRE_ORDER_BUYER_IP_RATE_LIMITED',
    message: 'Too many pre-order status requests from this IP',
  },
})

const statusLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 45,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: req => String(req.user?.user_id || ipKeyGenerator(req.ip)),
  message: {
    ok: false,
    code: 'PRE_ORDER_BUYER_STATUS_RATE_LIMITED',
    message: 'Too many pre-order status requests',
  },
})

router.get('/pre-orders/payment-capabilities', ipStatusLimiter, requireUser, statusLimiter, getReaderPreOrderPaymentCapabilities)
router.get('/pre-orders/my-orders', ipStatusLimiter, requireUser, statusLimiter, getReaderPreOrderMyOrders)
router.get('/pre-orders/my-orders/:orderId/status', ipStatusLimiter, requireUser, statusLimiter, getReaderPreOrderOrderStatus)

export default router
