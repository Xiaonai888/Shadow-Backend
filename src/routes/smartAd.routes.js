import express from 'express'
import { rateLimit } from 'express-rate-limit'
import {
  getSmartAdVersion,
  postSmartAdSelection,
  postSmartAdImpressions,
  postSmartAdOpen,
} from '../controllers/smartAd.controller.js'

const router = express.Router()

const versionIpLimiter = rateLimit({
  windowMs: 60000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { ok: false, message: 'Too many Smart Ad requests' },
})

const selectIpLimiter = rateLimit({
  windowMs: 60000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { ok: false, message: 'Too many Smart Ad requests' },
})

const impressionsIpLimiter = rateLimit({
  windowMs: 60000,
  limit: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { ok: false, message: 'Too many Smart Ad requests' },
})

const openIpLimiter = rateLimit({
  windowMs: 60000,
  limit: 45,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { ok: false, message: 'Too many Smart Ad requests' },
})

router.get('/version', versionIpLimiter, getSmartAdVersion)
router.post('/select', selectIpLimiter, postSmartAdSelection)
router.post('/impressions', impressionsIpLimiter, postSmartAdImpressions)
router.post('/open', openIpLimiter, postSmartAdOpen)

export default router
