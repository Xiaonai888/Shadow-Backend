import express from 'express'
import { rateLimit } from 'express-rate-limit'
import { requireUser } from '../middleware/user.middleware.js'
import { createRateLimit } from '../middleware/rateLimit.middleware.js'
import {
  deleteAuthorStoreCustomDeliveryCompany,
  getAuthorStoreCustomDeliveryCompany,
  getOwnedActiveAuthorStorePage,
  saveAuthorStoreCustomDeliveryCompany,
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

const readAccountLimit = createRateLimit({
  key: 'custom-delivery-company-read',
  windowMs: 60 * 60 * 1000,
  max: 120,
  identity: (req) => req.user?.user_id,
})

const saveAccountLimit = createRateLimit({
  key: 'custom-delivery-company-save',
  windowMs: 60 * 60 * 1000,
  max: 12,
  identity: (req) => req.user?.user_id,
})

const deleteAccountLimit = createRateLimit({
  key: 'custom-delivery-company-delete',
  windowMs: 60 * 60 * 1000,
  max: 12,
  identity: (req) => req.user?.user_id,
})

function respondWithError(res, error, code, message) {
  if (!error?.statusCode) console.error(`${code}:`, error)
  const status = Number(error?.statusCode)
  const safeStatus = Number.isInteger(status) && status >= 400 && status < 600 ? status : 503
  return res.status(safeStatus).json({
    ok: false,
    code: error?.code && error?.statusCode ? error.code : code,
    message: error?.code && error?.statusCode ? error.message : message,
  })
}

router.get('/me/delivery-settings/custom', ipLimit, requireUser, readAccountLimit, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  try {
    const userId = req.user?.user_id
    const authorPageId = await getOwnedActiveAuthorStorePage(userId)
    const company = await getAuthorStoreCustomDeliveryCompany(authorPageId, userId)
    return res.status(200).json({ ok: true, custom_company: company })
  } catch (error) {
    return respondWithError(res, error, 'CUSTOM_DELIVERY_LOAD_FAILED', 'Could not load the custom delivery company')
  }
})

router.put('/me/delivery-settings/custom', ipLimit, requireUser, saveAccountLimit, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  try {
    const userId = req.user?.user_id
    const authorPageId = await getOwnedActiveAuthorStorePage(userId)
    const input = req.body?.custom_company ?? req.body?.company
    const company = await saveAuthorStoreCustomDeliveryCompany(authorPageId, userId, input)
    return res.status(200).json({ ok: true, custom_company: company })
  } catch (error) {
    return respondWithError(res, error, 'CUSTOM_DELIVERY_SAVE_FAILED', 'Could not save the custom delivery company')
  }
})

router.delete('/me/delivery-settings/custom', ipLimit, requireUser, deleteAccountLimit, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  try {
    const userId = req.user?.user_id
    const authorPageId = await getOwnedActiveAuthorStorePage(userId)
    await deleteAuthorStoreCustomDeliveryCompany(authorPageId, userId)
    return res.status(200).json({ ok: true, deleted: true })
  } catch (error) {
    return respondWithError(res, error, 'CUSTOM_DELIVERY_DELETE_FAILED', 'Could not delete the custom delivery company')
  }
})

export default router
