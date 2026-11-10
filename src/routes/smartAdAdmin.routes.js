import express from 'express'
import { ipKeyGenerator, rateLimit } from 'express-rate-limit'
import { requireAdmin } from '../middleware/auth.middleware.js'
import {
  getSmartAdAdminReadiness,
  postSmartAdAdminBootstrap,
  postSmartAdAdminRefresh,
} from '../controllers/smartAdAdmin.controller.js'

const router = express.Router()

function ownerOnly(req, res, next) {
  if (String(req.admin?.role || '').toLowerCase() !== 'owner') {
    return res.status(403).json({
      ok: false,
      code: 'SMART_AD_OWNER_REQUIRED',
      message: 'Owner access is required for pool operations',
    })
  }
  return next()
}

function adminKey(req) {
  return String(
    req.admin?.admin_id || req.admin?.id || req.admin?.sub ||
    req.admin?.email || ipKeyGenerator(req.ip)
  )
}

const readLimit = rateLimit({
  windowMs: 60_000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: adminKey,
  message: { ok: false, code: 'SMART_AD_ADMIN_RATE_LIMIT' },
})

const writeLimit = rateLimit({
  windowMs: 60 * 60_000,
  limit: 2,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: adminKey,
  message: { ok: false, code: 'SMART_AD_ADMIN_RATE_LIMIT' },
})

router.use(requireAdmin)
router.get('/status', readLimit, getSmartAdAdminReadiness)
router.post('/bootstrap', ownerOnly, writeLimit, postSmartAdAdminBootstrap)
router.post('/refresh', ownerOnly, writeLimit, postSmartAdAdminRefresh)

export default router
