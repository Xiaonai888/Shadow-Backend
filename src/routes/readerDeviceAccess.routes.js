import express from 'express'
import { supabase } from '../config/supabase.js'
import { requireUser } from '../middleware/user.middleware.js'
import { createRateLimit } from '../middleware/rateLimit.middleware.js'

const router = express.Router()
const MAX_ACTIVE_SESSIONS = 5
const deviceReadLimit = createRateLimit({
  key: 'reader-device-sessions-read',
  windowMs: 60000,
  max: 20,
  identity: (req) => req.user?.user_id,
})
const deviceRevokeLimit = createRateLimit({
  key: 'reader-device-sessions-revoke',
  windowMs: 60000,
  max: 10,
  identity: (req) => req.user?.user_id,
})

router.use(requireUser)

router.get('/', deviceReadLimit, async (req, res) => {
  if (!req.user?.session_id) {
    return res.status(409).json({
      ok: false,
      code: 'READER_MANAGED_SESSION_REQUIRED',
      message: 'Please sign in again to manage login devices.',
    })
  }

  try {
    const userId = req.user.user_id
    const { data: sessions, error: sessionError } = await supabase
      .from('reader_sessions')
      .select('id,device_id,created_at,last_seen_at,expires_at')
      .eq('user_id', userId)
      .is('revoked_at', null)
      .gt('expires_at', new Date().toISOString())
      .order('last_seen_at', { ascending: false })
      .limit(MAX_ACTIVE_SESSIONS)

    if (sessionError) throw sessionError

    const deviceIds = [...new Set((sessions || []).map((s) => s.device_id))]
    let devices = []

    if (deviceIds.length) {
      const { data, error } = await supabase
        .from('reader_devices')
        .select('id,device_label,browser_name,os_name,last_ip,last_login_at,last_seen_at')
        .eq('user_id', userId)
        .in('id', deviceIds)
        .limit(MAX_ACTIVE_SESSIONS)

      if (error) throw error
      devices = data || []
    }

    const deviceById = new Map(devices.map((device) => [device.id, device]))
    const activeSessions = (sessions || []).map((session) => ({
      id: session.id,
      device_id: session.device_id,
      device_label: deviceById.get(session.device_id)?.device_label || 'Unknown device',
      browser_name: deviceById.get(session.device_id)?.browser_name || '',
      os_name: deviceById.get(session.device_id)?.os_name || '',
      last_ip: deviceById.get(session.device_id)?.last_ip || '',
      last_login_at: deviceById.get(session.device_id)?.last_login_at || null,
      last_seen_at: session.last_seen_at,
      created_at: session.created_at,
      expires_at: session.expires_at,
      is_current: session.id === req.user.session_id,
    }))

    return res.status(200).json({
      ok: true,
      max_sessions: MAX_ACTIVE_SESSIONS,
      active_sessions: activeSessions.length,
      sessions: activeSessions,
    })
  } catch (error) {
    console.error('READER DEVICE LIST ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Unable to load login devices.' })
  }
})

router.patch('/:deviceId/revoke', deviceRevokeLimit, async (req, res) => {
  if (!req.user?.session_id) {
    return res.status(409).json({
      ok: false,
      code: 'READER_MANAGED_SESSION_REQUIRED',
      message: 'Please sign in again to manage login devices.',
    })
  }

  const deviceId = String(req.params.deviceId || '').trim()
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(deviceId)) {
    return res.status(400).json({ ok: false, message: 'Invalid device ID.' })
  }

  try {
    const userId = req.user.user_id
    const { data: device, error: deviceError } = await supabase
      .from('reader_devices')
      .select('id')
      .eq('id', deviceId)
      .eq('user_id', userId)
      .maybeSingle()

    if (deviceError) throw deviceError
    if (!device) return res.status(404).json({ ok: false, message: 'Device not found.' })

    const now = new Date().toISOString()
    const { data: revoked, error: revokeError } = await supabase
      .from('reader_sessions')
      .update({
        revoked_at: now,
        revoked_reason: 'Logged out from reader device management',
      })
      .eq('user_id', userId)
      .eq('device_id', device.id)
      .is('revoked_at', null)
      .gt('expires_at', now)
      .select('id')

    if (revokeError) throw revokeError

    return res.status(200).json({
      ok: true,
      revoked_sessions: (revoked || []).length,
      current_session_revoked: (revoked || []).some((session) => session.id === req.user.session_id),
    })
  } catch (error) {
    console.error('READER DEVICE REVOKE ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Unable to log out this device.' })
  }
})

export default router
