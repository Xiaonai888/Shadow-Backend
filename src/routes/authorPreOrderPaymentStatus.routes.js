import express from 'express'
import { ipKeyGenerator, rateLimit } from 'express-rate-limit'
import { requireUser } from '../middleware/user.middleware.js'
import {
  getReaderPreOrderPaymentCapabilities,
  getReaderPreOrderOrderStatus,
  getReaderPreOrderMyOrders,
} from '../controllers/authorPreOrderPaymentStatus.controller.js'

const router = express.Router()
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

router.use(requireUser, statusLimiter)
router.get('/pre-orders/payment-capabilities', getReaderPreOrderPaymentCapabilities)
router.get('/pre-orders/my-orders', getReaderPreOrderMyOrders)
router.get('/pre-orders/my-orders/:orderId/status', getReaderPreOrderOrderStatus)

export default router
