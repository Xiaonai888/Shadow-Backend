import express from 'express'
import { rateLimit } from 'express-rate-limit'
import { requireUser } from '../middleware/user.middleware.js'
import {
  getSmartPdfPromotionVersion,
  postSmartPdfPromotionSelection,
  postSmartPdfPromotionEvents,
} from '../controllers/smartPdf.controller.js'

const router = express.Router()

const versionLimit = rateLimit({
  windowMs: 60000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { ok: false, message: 'Too many PDF promotion requests' },
})

const selectionLimit = rateLimit({
  windowMs: 60000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { ok: false, message: 'Too many PDF promotion requests' },
})

const eventLimit = rateLimit({
  windowMs: 60000,
  limit: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { ok: false, message: 'Too many PDF promotion requests' },
})

function verifyReaderSessionIfPresent(req, res, next) {
  if (req.headers?.authorization) return requireUser(req, res, next)
  return next()
}

router.get('/version', versionLimit, getSmartPdfPromotionVersion)
router.post('/select', selectionLimit, verifyReaderSessionIfPresent, postSmartPdfPromotionSelection)
router.post('/events', eventLimit, verifyReaderSessionIfPresent, postSmartPdfPromotionEvents)

export default router
