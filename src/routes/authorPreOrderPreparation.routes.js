import express from 'express'
import { ipKeyGenerator, rateLimit } from 'express-rate-limit'
import { requireUser } from '../middleware/user.middleware.js'
import { previewReaderPreOrderPreparation } from '../controllers/authorPreOrderPreparation.controller.js'

const router = express.Router()

const preparationLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 12,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: req => ipKeyGenerator(req.ip),
  message: {
    ok: false,
    code: 'PRE_ORDER_PREPARATION_RATE_LIMITED',
    message: 'Too many checkout previews. Try again shortly.',
  },
})

router.post(
  '/pre-orders/:campaignId/prepare',
  preparationLimiter,
  requireUser,
  previewReaderPreOrderPreparation
)

export default router
