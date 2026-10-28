import express from 'express'
import { rateLimit } from 'express-rate-limit'
import { supabase } from '../config/supabase.js'
import { requireUser } from '../middleware/user.middleware.js'
import { markRequestDiagnostic } from '../services/trafficDiagnostic.service.js'

const router = express.Router()
const limiter = rateLimit({
  windowMs: 60000,
  limit: 15,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req) => String(req.user?.user_id || req.user?.id || 'unauthenticated'),
  handler: (req, res) => {
    markRequestDiagnostic({
      feature: 'reader_offline_control',
      failure_stage: 'per_reader_rate_limit',
      error_code: 'READER_OFFLINE_CONTROL_RATE_LIMIT',
      http_status: 429,
    })
    return res.status(429).json({
      ok: false,
      code: 'READER_OFFLINE_CONTROL_RATE_LIMIT',
      message: 'Too many requests. Please try again later.',
    })
  },
})

router.get('/', requireUser, limiter, async (req, res) => {
  res.set('Cache-Control', 'private, no-store')
  try {
    const { data, error } = await supabase.rpc('shadow_offline_reader_effective', {
      p_user_id: req.user.user_id,
      p_device_id: req.user.device_id,
    })
    if (error) throw error
    return res.json({ ok: true, control: data })
  } catch (error) {
    const code = String(error?.code || 'UNKNOWN').slice(0, 40)
    const message = String(error?.message || 'Unknown RPC error').slice(0, 180)
    markRequestDiagnostic({
      feature: 'reader_offline_control',
      failure_stage: 'rpc_shadow_offline_reader_effective',
      error_code: code,
      http_status: 503,
    })
    console.error('READER_OFFLINE_CONTROL_RPC_ERROR', {
      stage: 'rpc_shadow_offline_reader_effective',
      code,
      message,
      details: String(error?.details || '').slice(0, 240),
      hint: String(error?.hint || '').slice(0, 240),
      status: Number(error?.status) || null,
    })
    return res.status(503).json({
      ok: false,
      code: 'READER_OFFLINE_CONTROL_RPC_UNAVAILABLE',
      message: 'Offline mode settings are temporarily unavailable',
    })
  }
})

export default router
