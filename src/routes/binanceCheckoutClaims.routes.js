import express from 'express'
import { rateLimit } from 'express-rate-limit'
import { requireUser } from '../middleware/user.middleware.js'
import {
  getReaderBinanceClaim,
  submitReaderBinanceClaim,
} from '../controllers/binanceCheckoutClaims.controller.js'

const router = express.Router()
const ipLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {
    ok: false,
    code: 'BINANCE_CLAIM_RATE_LIMIT',
    message: 'Too many requests. Please try again shortly.',
  },
})
const readerReadLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req) => String(req.user?.user_id || req.user?.id),
})
const readerWriteLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req) => String(req.user?.user_id || req.user?.id),
})

router.get('/checkout/:orderId/claim', ipLimit, requireUser, readerReadLimit, getReaderBinanceClaim)
router.post('/checkout/:orderId/claim', ipLimit, requireUser, readerWriteLimit, submitReaderBinanceClaim)

export default router
