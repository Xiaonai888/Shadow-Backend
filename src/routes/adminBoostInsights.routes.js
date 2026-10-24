import express from 'express'
import { ipKeyGenerator, rateLimit } from 'express-rate-limit'
import { requireAdminPermission } from '../middleware/adminPermission.middleware.js'
import { getAdminBoostInsights } from '../controllers/adminBoostInsights.controller.js'

const router = express.Router()

const adminBoostInsightsIpLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 600,
  standardHeaders: false,
  legacyHeaders: false,
  message: {
    ok: false,
    code: 'ADMIN_BOOST_INSIGHTS_IP_RATE_LIMIT',
    message: 'Too many Boost Insights requests. Please retry shortly.',
  },
})

const adminBoostInsightsReadLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 240,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req) => String(
    req.admin?.admin_id ||
    req.admin?.id ||
    req.admin?.sub ||
    req.admin?.email ||
    ipKeyGenerator(req.ip)
  ),
  message: {
    ok: false,
    code: 'ADMIN_BOOST_INSIGHTS_RATE_LIMIT',
    message: 'Too many Boost Insights requests. Please retry shortly.',
  },
})

router.get('/insights', adminBoostInsightsIpLimit, requireAdminPermission('advertisement.view'), adminBoostInsightsReadLimit, getAdminBoostInsights)

export default router
