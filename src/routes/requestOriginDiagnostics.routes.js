import express from 'express'
import { rateLimit } from 'express-rate-limit'
import { recordRequestOriginReport } from '../services/requestOriginDiagnostics.service.js'

const router = express.Router()
const limiter = rateLimit({
  windowMs: 60_000,
  limit: 12,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { ok: false, code: 'REQUEST_ORIGIN_RATE_LIMITED' },
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

router.post('/', limiter, express.text({ type: 'text/plain', limit: '4kb' }), (req, res) => {
  res.set('Cache-Control', 'no-store')
  if (!allowedOrigin(req.get('origin'))) {
    return res.status(403).json({ ok: false, code: 'REQUEST_ORIGIN_ORIGIN_DENIED' })
  }
  if (typeof req.body !== 'string' || Buffer.byteLength(req.body) > 3600) {
    return res.status(400).json({ ok: false, code: 'REQUEST_ORIGIN_BAD_PAYLOAD' })
  }
  let payload
  try {
    payload = JSON.parse(req.body)
  } catch {
    return res.status(400).json({ ok: false, code: 'REQUEST_ORIGIN_BAD_JSON' })
  }
  if (!recordRequestOriginReport(payload)) {
    return res.status(400).json({ ok: false, code: 'REQUEST_ORIGIN_INVALID_EVENTS' })
  }
  return res.status(204).end()
})

export default router
