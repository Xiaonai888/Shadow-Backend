import express from 'express'
import { rateLimit } from 'express-rate-limit'
import { requireUser } from '../middleware/user.middleware.js'
import { createRateLimit } from '../middleware/rateLimit.middleware.js'
import {
  deleteAuthorStoreCustomDeliveryCompany,
  getOwnedActiveAuthorStorePage,
} from '../services/authorStoreCustomDelivery.service.js'

const router = express.Router()

const ipLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {
    ok: false,
    code: 'CUSTOM_DELIVERY_RATE_LIMIT',
    message: 'Too many delivery company requests. Please try again shortly.',
  },
})

const accountLimit = createRateLimit({
  key: 'custom-delivery-company-delete',
  windowMs: 60 * 60 * 1000,
  max: 12,
  identity: (req) => req.user?.user_id,
})

router.delete('/me/delivery-settings/custom', ipLimit, requireUser, accountLimit, async (req, res) => {
  try {
    const userId = req.user?.user_id
    const authorPageId = await getOwnedActiveAuthorStorePage(userId)
    await deleteAuthorStoreCustomDeliveryCompany(authorPageId, userId)
    return res.status(200).json({ ok: true, deleted: true })
  } catch (error) {
    if (!error?.statusCode) console.error('CUSTOM DELIVERY DELETE ERROR:', error)
    return res.status(error?.statusCode || 503).json({
      ok: false,
      code: error?.code && error?.statusCode ? error.code : 'CUSTOM_DELIVERY_DELETE_FAILED',
      message: error?.code && error?.statusCode ? error.message : 'Could not delete the custom delivery company',
    })
  }
})

export default router
