import express from 'express'
import { rateLimit } from 'express-rate-limit'
import {
  getSmartAdVersion,
  postSmartAdSelection,
  postSmartAdImpressions,
  postSmartAdOpen,
} from '../controllers/smartAd.controller.js'

const router = express.Router()

function guard(limit) {
  return rateLimit({
    windowMs: 60000,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { ok: false, message: 'Too many Smart Ad requests' },
  })
}

router.get('/version', guard(30), getSmartAdVersion)
router.post('/select', guard(30), postSmartAdSelection)
router.post('/impressions', guard(60), postSmartAdImpressions)
router.post('/open', guard(45), postSmartAdOpen)

export default router
