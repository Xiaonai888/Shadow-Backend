import express from 'express'
import { supabase } from '../config/supabase.js'
import { requireUser } from '../middleware/user.middleware.js'
import { createRateLimit } from '../middleware/rateLimit.middleware.js'

const router = express.Router()
const limiter = createRateLimit({
  key: 'reader-offline-mode-read',
  windowMs: 60000,
  max: 15,
  identity: (req) => req.user?.user_id,
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
