import express from 'express'
import { rateLimit, ipKeyGenerator } from 'express-rate-limit'
import { handleAuthorPreOrderAbaCallback } from '../controllers/authorPreOrderAbaCallback.controller.js'

const router = express.Router()

const callbackLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: req => ipKeyGenerator(req.ip),
  message: { ok: false, code: 'PRE_ORDER_CALLBACK_RATE_LIMITED' },
})

router.post('/pre-orders/aba-callback', callbackLimiter, handleAuthorPreOrderAbaCallback)

export default router
