import express from 'express'
import { rateLimit } from 'express-rate-limit'
import { postSmartPromotionActive } from '../controllers/smartPromotion.controller.js'

const router = express.Router()

const readerRateLimit = rateLimit({
  windowMs: 60_000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { ok: false, message: 'Too many Special Promotion requests' },
})

router.post('/active', readerRateLimit, postSmartPromotionActive)

export default router
