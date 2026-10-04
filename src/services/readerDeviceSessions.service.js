import crypto from 'node:crypto'
import { supabase } from '../config/supabase.js'

const SESSION_DAYS = 60
const TOUCH_INTERVAL_MS = 5 * 60 * 1000
const SESSION_DURATION_MS = SESSION_DAYS * 24 * 60 * 60 * 1000
const SESSION_VALIDATION_CACHE_MS = 30 * 1000
const SESSION_VALIDATION_CACHE_LIMIT = 5000

const sessionValidationCache = new Map()
const sessionValidationInFlight = new Map()

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

function sessionValidationKey(decoded) {
  return [
    decoded?.user_id || '',
    decoded?.session_id || '',
    decoded?.device_id || '',
    decoded?.jwt_id || '',
  ].join(':')
}

function readSessionValidationCache(decoded) {
  const key = sessionValidationKey(decoded)
  const cached = sessionValidationCache.get(key)

  if (!cached) return null

  const now = Date.now()
  if (cached.expiresAt <= now || cached.sessionExpiresAt <= now) {
    sessionValidationCache.delete(key)
    return null
  }

  return cached.result
}

function writeSessionValidationCache(decoded, sessionExpiresAt) {
  const key = sessionValidationKey(decoded)
  const sessionExpiry = new Date(sessionExpiresAt).getTime()

  if (!Number.isFinite(sessionExpiry) || sessionExpiry <= Date.now()) return

  if (sessionValidationCache.size >= SESSION_VALIDATION_CACHE_LIMIT) {
    sessionValidationCache.delete(sessionValidationCache.keys().next().value)
  }

  sessionValidationCache.set(key, {
    result: {
      ok: true,
      sessionId: decoded.session_id,
      deviceId: decoded.device_id,
    },
    expiresAt: Math.min(Date.now() + SESSION_VALIDATION_CACHE_MS, sessionExpiry),
    sessionExpiresAt: sessionExpiry,
  })
}

export async function createReaderDeviceSession({ req, userId, deviceKey }) {
  const key = /^[a-f0-9]{64}$/.test(String(deviceKey || ''))
    ? deviceKey
    : crypto.randomBytes(32).toString('hex')
  const deviceInfo = getDeviceInfo(req)
  const jwtId = crypto.randomUUID()
  const { data, error } = await supabase.rpc('reader_register_device_session', {
    p_user_id: userId,
    p_device_key_hash: crypto.createHash('sha256').update(key).digest('hex'),
    p_device_label: deviceInfo.device_label,
    p_browser_name: deviceInfo.browser_name,
    p_os_name: deviceInfo.os_name,
    p_last_ip: deviceInfo.last_ip,
    p_last_user_agent: deviceInfo.last_user_agent,
    p_jwt_id: jwtId,
  }).single()

  if (error) {
    if (String(error.message || '').includes('READER_SESSION_LIMIT_REACHED')) {
      const limitError = new Error('Maximum 5 active sessions')
      limitError.code = 'READER_SESSION_LIMIT_REACHED'
      throw limitError
    }
    throw error
  }

  if (!data?.device_id || !data?.session_id || !data?.expires_at) {
    throw new Error('Reader session registration returned incomplete data')
  }

  writeSessionValidationCache(
    {
      user_id: userId,
      session_id: data.session_id,
      device_id: data.device_id,
      jwt_id: jwtId,
    },
    data.expires_at
  )

  return {
    deviceKey: key,
    deviceId: data.device_id,
    sessionId: data.session_id,
    jwtId,
    expiresAt: data.expires_at,
  }
}

export async function validateReaderDeviceSession(decoded) {
  if (!decoded?.user_id || !decoded?.session_id || !decoded?.device_id || !decoded?.jwt_id) {
    return { ok: false, code: 'READER_SESSION_REQUIRED' }
  }

  const cached = readSessionValidationCache(decoded)
  if (cached) return cached

  const cacheKey = sessionValidationKey(decoded)
  const pending = sessionValidationInFlight.get(cacheKey)
  if (pending) return pending

  const validation = (async () => {
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
      sessionValidationCache.delete(cacheKey)
      return { ok: false, code: 'READER_SESSION_REVOKED' }
    }

    const nowMs = Date.now()
    if (new Date(session.expires_at).getTime() <= nowMs) {
      sessionValidationCache.delete(cacheKey)
      return { ok: false, code: 'READER_SESSION_EXPIRED' }
    }

    let sessionExpiresAt = session.expires_at

    if (nowMs - new Date(session.last_seen_at).getTime() >= TOUCH_INTERVAL_MS) {
      const now = new Date(nowMs).toISOString()
      sessionExpiresAt = new Date(nowMs + SESSION_DURATION_MS).toISOString()
      const { data: touched, error: touchError } = await supabase
        .from('reader_sessions')
        .update({
          last_seen_at: now,
          expires_at: sessionExpiresAt,
        })
        .eq('id', session.id)
        .is('revoked_at', null)
        .gt('expires_at', now)
        .select('id')
        .maybeSingle()

      if (touchError) throw touchError
      if (!touched) {
        sessionValidationCache.delete(cacheKey)
        return { ok: false, code: 'READER_SESSION_REVOKED' }
      }

      const { error: deviceError } = await supabase
        .from('reader_devices')
        .update({ last_seen_at: now })
        .eq('id', decoded.device_id)
        .eq('user_id', decoded.user_id)

      if (deviceError) throw deviceError
    }

    writeSessionValidationCache(decoded, sessionExpiresAt)

    return {
      ok: true,
      sessionId: session.id,
      deviceId: decoded.device_id,
    }
  })()

  sessionValidationInFlight.set(cacheKey, validation)

  try {
    return await validation
  } finally {
    if (sessionValidationInFlight.get(cacheKey) === validation) {
      sessionValidationInFlight.delete(cacheKey)
    }
  }
}
