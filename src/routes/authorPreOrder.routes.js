import express from 'express'
import { rateLimit, ipKeyGenerator } from 'express-rate-limit'
import { requireUser } from '../middleware/user.middleware.js'
import {
  listMyAuthorPreOrders,
  getMyAuthorPreOrder,
  createMyAuthorPreOrderDraft,
  updateMyAuthorPreOrderDraft,
  publishMyAuthorPreOrder,
} from '../controllers/authorPreOrder.controller.js'

const router = express.Router()

const requestLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: req => String(req.user?.user_id || ipKeyGenerator(req.ip)),
  message: {
    ok: false,
    code: 'PRE_ORDER_RATE_LIMITED',
    message: 'Too many pre-order requests. Please try again shortly.',
  },
})

const writeLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 8,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: req => String(req.user?.user_id || ipKeyGenerator(req.ip)),
  message: {
    ok: false,
    code: 'PRE_ORDER_WRITE_RATE_LIMITED',
    message: 'Too many pre-order changes. Please try again shortly.',
  },
})

router.use(requireUser, requestLimiter)
router.get('/me/pre-orders', listMyAuthorPreOrders)
router.get('/me/pre-orders/:campaignId', getMyAuthorPreOrder)
router.post('/me/pre-orders', writeLimiter, createMyAuthorPreOrderDraft)
router.put('/me/pre-orders/:campaignId', writeLimiter, updateMyAuthorPreOrderDraft)
router.post('/me/pre-orders/:campaignId/publish', writeLimiter, publishMyAuthorPreOrder)

export default router
