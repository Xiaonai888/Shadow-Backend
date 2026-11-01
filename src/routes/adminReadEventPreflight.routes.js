import express from 'express'
import { rateLimit } from 'express-rate-limit'
import { requireAdminPermission } from '../middleware/adminPermission.middleware.js'
import { readShadowReadEventReleaseReadiness } from '../services/shadowReadEventReleaseReadiness.service.js'

const router = express.Router()
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const manualOnly = rateLimit({
  windowMs: 60_000,
  limit: 6,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req) => String(req.admin?.admin_id || req.admin?.email || req.ip),
  message: { ok: false, code: 'READ_EVENT_PREFLIGHT_RATE_LIMIT' },
})

router.use(requireAdminPermission('monthly_vote.view'), manualOnly)

router.get('/:eventId', async (req, res) => {
  res.set('Cache-Control', 'private, no-store')
  const eventId = req.params.eventId
  if (req.admin?.role !== 'owner' && req.admin?.role !== 'admin') {
    return res.status(403).json({ ok: false, code: 'READ_EVENT_MANAGER_REQUIRED' })
  }
  if (!UUID.test(eventId)) {
    return res.status(400).json({ ok: false, code: 'READ_EVENT_ID_INVALID' })
  }

  try {
    const report = await readShadowReadEventReleaseReadiness({ eventId })
    return res.status(200).json(report)
  } catch (error) {
    console.error('READ_EVENT_PREFLIGHT_ERROR', {
      code: error?.code || error?.name || 'unknown',
    })
    return res.status(503).json({ ok: false, code: 'READ_EVENT_PREFLIGHT_UNAVAILABLE' })
  }
})

export default router
