import express from 'express'
import { rateLimit } from 'express-rate-limit'
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

router.get('/version', versionLimit, getSmartPdfPromotionVersion)
router.post('/select', selectionLimit, postSmartPdfPromotionSelection)
router.post('/events', eventLimit, postSmartPdfPromotionEvents)

export default router
