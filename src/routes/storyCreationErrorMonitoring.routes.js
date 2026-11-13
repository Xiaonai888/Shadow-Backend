import express from 'express'
import { rateLimit } from 'express-rate-limit'
import { requireUser } from '../middleware/user.middleware.js'
import { requireAdminPermission } from '../middleware/adminPermission.middleware.js'
import {
  getStoryCreationErrorDiagnostics,
  recordStoryCreationError,
} from '../services/storyCreationErrorMonitoring.service.js'

export const storyCreationErrorPublicRoutes = express.Router()
export const storyCreationErrorAdminRoutes = express.Router()

const reportLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 15,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { ok: false, code: 'STORY_ERROR_REPORT_RATE_LIMIT' },
})
const adminLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
})

function allowedOrigin(value) {
  return Boolean(value) && new Set([
    'https://shadowerabook.site',
    'https://www.shadowerabook.site',
    'http://localhost:5173',
    'http://localhost:5174',
    'http://127.0.0.1:5173',
    'http://127.0.0.1:5174',
    process.env.FRONTEND_URL,
  ].filter(Boolean)).has(value)
}

storyCreationErrorPublicRoutes.post('/', reportLimiter, requireUser, async (req, res) => {
  res.set('Cache-Control', 'no-store')
  if (!allowedOrigin(req.get('origin'))) {
    return res.status(403).json({ ok: false, code: 'STORY_ERROR_ORIGIN_DENIED' })
  }
  if (Number(req.get('content-length') || 0) > 2048 ||
    Buffer.byteLength(JSON.stringify(req.body || {})) > 2048) {
    return res.status(413).json({ ok: false, code: 'STORY_ERROR_PAYLOAD_TOO_LARGE' })
  }
  const result = await recordStoryCreationError(req.user?.user_id, req.body)
  if (!result.ok) {
    return res.status(result.status || 503).json({ ok: false, code: result.code })
  }
  return res.status(204).end()
})

storyCreationErrorAdminRoutes.get('/', adminLimiter,
  requireAdminPermission('system_control.view'), async (req, res) => {
    res.set('Cache-Control', 'no-store')
    const hours = Number(req.query.hours || 24)
    if (![1, 6, 24, 168].includes(hours)) {
      return res.status(400).json({ ok: false, code: 'STORY_ERROR_BAD_RANGE' })
    }
    const report = await getStoryCreationErrorDiagnostics(hours, req.query.refresh === '1')
    return res.status(200).json({ ok: true, report })
  })
