import express from 'express'
import { ipKeyGenerator, rateLimit } from 'express-rate-limit'
import {
  getPublicAuthorPreOrders,
  getPublicAuthorPreOrderDetail,
  getPublicAuthorPreOrderQuote,
} from '../controllers/authorPreOrderReader.controller.js'

const router = express.Router()

const readLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: req => ipKeyGenerator(req.ip),
  message: { ok: false, code: 'PRE_ORDER_READER_READ_LIMITED', message: 'Too many pre-order requests' },
})

const quoteLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: req => ipKeyGenerator(req.ip),
  message: { ok: false, code: 'PRE_ORDER_READER_QUOTE_LIMITED', message: 'Too many price checks' },
})

router.get('/pre-orders', readLimiter, getPublicAuthorPreOrders)
router.get('/pre-orders/:campaignId', readLimiter, getPublicAuthorPreOrderDetail)
router.post('/pre-orders/:campaignId/quote', quoteLimiter, getPublicAuthorPreOrderQuote)

export default router
