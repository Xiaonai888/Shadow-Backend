import crypto from 'node:crypto'
import { supabase } from '../config/supabase.js'

const SESSION_DAYS = 60
const TOUCH_INTERVAL_MS = 5 * 60 * 1000
const SESSION_DURATION_MS = SESSION_DAYS * 24 * 60 * 60 * 1000

function getDeviceInfo(req) {
  const agent = String(req.headers['user-agent'] || '').slice(0, 1000)
  const browser = /Edg\//i.test(agent) ? 'Edge' : /Firefox\//i.test(agent) ? 'Firefox' : /CriOS\//i.test(agent) ? 'Chrome' : /Chrome\//i.test(agent) ? 'Chrome' : /Safari\//i.test(agent) ? 'Safari' : 'Unknown browser'
  const os = /Android/i.test(agent) ? 'Android' : /iPhone|iPad|iPod/i.test(agent) ? 'iOS' : /Windows/i.test(agent) ? 'Windows' : /Mac OS|Macintosh/i.test(agent) ? 'macOS' : /Linux/i.test(agent) ? 'Linux' : 'Unknown OS'
  return {
    browser_name: browser,
    os_name: os,
    device_label: `${browser} on ${os}`,
    last_user_agent: agent,
    last_ip: String(req.ip || req.socket?.remoteAddress || '').slice(0, 100),
  }
}

export async function createReaderDeviceSession({ req, userId, deviceKey }) {
  const key = /^[a-f0-9]{64}$/.test(String(deviceKey || ''))
    ? deviceKey
    : crypto.randomBytes(32).toString('hex')
  const now = new Date().toISOString()
  const deviceInfo = getDeviceInfo(req)
  const { data: device, error: deviceError } = await supabase
    .from('reader_devices')
    .upsert({
      user_id: userId,
      device_key_hash: crypto.createHash('sha256').update(key).digest('hex'),
      ...deviceInfo,
      last_login_at: now,
      last_seen_at: now,
    }, { onConflict: 'user_id,device_key_hash' })
    .select('id')
    .single()

  if (deviceError) throw deviceError

  const jwtId = crypto.randomUUID()
  const { data: session, error: sessionError } = await supabase
    .from('reader_sessions')
    .insert({
      user_id: userId,
      device_id: device.id,
      jwt_id: jwtId,
      created_at: now,
      last_seen_at: now,
      expires_at: new Date(Date.now() + SESSION_DURATION_MS).toISOString(),
    })
    .select('id,expires_at')
    .single()

  if (sessionError) throw sessionError

  return {
    deviceKey: key,
    deviceId: device.id,
    sessionId: session.id,
    jwtId,
    expiresAt: session.expires_at,
  }
}

export async function validateReaderDeviceSession(decoded) {
  if (!decoded?.user_id || !decoded?.session_id || !decoded?.device_id || !decoded?.jwt_id) {
    return { ok: false, code: 'READER_SESSION_REQUIRED' }
  }

  const { data: session, error } = await supabase
    .from('reader_sessions')
    .select('id,last_seen_at,expires_at,revoked_at')
    .eq('id', decoded.session_id)
    .eq('user_id', decoded.user_id)
    .eq('device_id', decoded.device_id)
    .eq('jwt_id', decoded.jwt_id)
    .maybeSingle()

  if (error) throw error
  if (!session || session.revoked_at) {
    return { ok: false, code: 'READER_SESSION_REVOKED' }
  }

  const nowMs = Date.now()
  if (new Date(session.expires_at).getTime() <= nowMs) {
    return { ok: false, code: 'READER_SESSION_EXPIRED' }
  }

  if (nowMs - new Date(session.last_seen_at).getTime() >= TOUCH_INTERVAL_MS) {
    const now = new Date(nowMs).toISOString()
    const { data: touched, error: touchError } = await supabase
      .from('reader_sessions')
      .update({
        last_seen_at: now,
        expires_at: new Date(nowMs + SESSION_DURATION_MS).toISOString(),
      })
      .eq('id', session.id)
      .is('revoked_at', null)
      .gt('expires_at', now)
      .select('id')
      .maybeSingle()

    if (touchError) throw touchError
    if (!touched) return { ok: false, code: 'READER_SESSION_REVOKED' }

    const { error: deviceError } = await supabase
      .from('reader_devices')
      .update({ last_seen_at: now })
      .eq('id', decoded.device_id)
      .eq('user_id', decoded.user_id)

    if (deviceError) throw deviceError
  }

  return { ok: true, sessionId: session.id, deviceId: decoded.device_id }
}
