import express from 'express'
import { rateLimit } from 'express-rate-limit'
import { requireAdminPermission } from '../middleware/adminPermission.middleware.js'
import {
  getReaderHealthDiagnostics,
  recordReaderHealthReport,
} from '../services/readerHealthTelemetry.service.js'

export const readerHealthPublicRoutes = express.Router()
export const readerHealthAdminRoutes = express.Router()

const reportLimiter = rateLimit({
  windowMs: 60000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { ok: false, code: 'READER_HEALTH_RATE_LIMIT' },
})
const adminLimiter = rateLimit({
  windowMs: 60000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
})

function allowedOrigin(value) {
  if (!value) return false
  return new Set([
    'https://shadowerabook.site',
    'https://www.shadowerabook.site',
    'http://localhost:5173',
    'http://localhost:5174',
    'http://127.0.0.1:5173',
    'http://127.0.0.1:5174',
    process.env.FRONTEND_URL,
  ].filter(Boolean)).has(value)
}

readerHealthPublicRoutes.post('/', reportLimiter, express.text({
  type: 'text/plain',
  limit: '4kb',
}), (req, res) => {
  res.set('Cache-Control', 'no-store')
  if (!allowedOrigin(req.get('origin'))) {
    return res.status(403).json({ ok: false, code: 'READER_HEALTH_ORIGIN_DENIED' })
  }
  if (typeof req.body !== 'string' || Buffer.byteLength(req.body) > 3800) {
    return res.status(400).json({ ok: false, code: 'READER_HEALTH_BAD_PAYLOAD' })
  }
  let payload
  try {
    payload = JSON.parse(req.body)
  } catch {
    return res.status(400).json({ ok: false, code: 'READER_HEALTH_BAD_JSON' })
  }
  if (!recordReaderHealthReport(payload)) {
    return res.status(400).json({ ok: false, code: 'READER_HEALTH_INVALID_EVENTS' })
  }
  return res.status(204).end()
})

readerHealthAdminRoutes.get('/', adminLimiter,
  requireAdminPermission('system_control.view'), async (req, res) => {
    res.set('Cache-Control', 'no-store')
    const hours = Number(req.query.hours || 24)
    if (![1, 6, 24, 168].includes(hours)) {
      return res.status(400).json({ ok: false, code: 'READER_HEALTH_BAD_RANGE' })
    }
    const report = await getReaderHealthDiagnostics(hours, req.query.refresh === '1')
    return res.status(200).json({ ok: true, report })
  })

export default readerHealthPublicRoutes
