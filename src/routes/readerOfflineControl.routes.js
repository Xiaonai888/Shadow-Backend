import express from 'express'
import { rateLimit } from 'express-rate-limit'
import { supabase } from '../config/supabase.js'
import { requireUser } from '../middleware/user.middleware.js'

const router = express.Router()
const limiter = rateLimit({
  windowMs: 60000,
  limit: 15,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req) => String(req.user?.user_id || req.user?.id || 'unauthenticated'),
  message: {
    ok: false,
    message: 'Too many requests. Please try again later.',
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
    console.error('READER OFFLINE CONTROL READ', error)
    return res.status(503).json({ ok: false, message: 'Offline mode settings are temporarily unavailable' })
  }
})

export default router
