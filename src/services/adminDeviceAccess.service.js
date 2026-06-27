import crypto from 'crypto'
import { isIP } from 'node:net'
import { supabase } from '../config/supabase.js'

export const ADMIN_DEVICE_COOKIE = 'shadow_admin_device_access'
export const MAX_ADMIN_ACTIVE_DEVICES = 2
const SESSION_DAYS = 7

function cleanText(value, maxLength = 1000) {
  return String(value || '').trim().slice(0, maxLength)
}

function normalizeEmail(value) {
  return cleanText(value, 320).toLowerCase()
}

function normalizeSingleIp(value) {
  const raw = cleanText(value, 150).replace(/^::ffff:/, '')
  return isIP(raw) ? raw : ''
}

function getForwardedIp(value) {
  return String(value || '')
    .split(',')
    .map((item) => normalizeSingleIp(item))
    .filter(Boolean)[0] || ''
}

export function getAdminDeviceClientIp(req) {
  return (
    getForwardedIp(req.headers['cf-connecting-ip'])
    || getForwardedIp(req.headers['x-real-ip'])
    || getForwardedIp(req.headers['x-forwarded-for'])
    || normalizeSingleIp(req.socket?.remoteAddress)
    || 'unknown'
  )
}

function getUserAgent(req) {
  return cleanText(req.headers['user-agent'], 1000)
}

function parseCookies(req) {
  return String(req.headers.cookie || '')
    .split(';')
    .map((item) => item.trim())
    .filter(Boolean)
    .reduce((acc, item) => {
      const index = item.indexOf('=')
      if (index <= 0) return acc
      const key = item.slice(0, index).trim()
      const value = item.slice(index + 1).trim()
      acc[key] = decodeURIComponent(value)
      return acc
    }, {})
}

function randomToken() {
  return crypto.randomBytes(32).toString('hex')
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex')
}

function getCookieOptions() {
  const secure = process.env.NODE_ENV === 'production' || Boolean(process.env.RENDER)

  return {
    httpOnly: true,
    secure,
    sameSite: secure ? 'none' : 'lax',
    maxAge: 365 * 24 * 60 * 60 * 1000,
    path: '/',
  }
}

function parseBrowser(userAgent) {
  const ua = String(userAgent || '')
  let browserName = 'Unknown Browser'
  let osName = 'Unknown OS'

  if (/Edg\//i.test(ua)) browserName = 'Microsoft Edge'
  else if (/Chrome\//i.test(ua)) browserName = 'Chrome'
  else if (/Firefox\//i.test(ua)) browserName = 'Firefox'
  else if (/Safari\//i.test(ua)) browserName = 'Safari'

  if (/Windows/i.test(ua)) osName = 'Windows'
  else if (/Android/i.test(ua)) osName = 'Android'
  else if (/iPhone|iPad|iOS/i.test(ua)) osName = 'iOS'
  else if (/Mac OS|Macintosh/i.test(ua)) osName = 'macOS'
  else if (/Linux/i.test(ua)) osName = 'Linux'

  return { browserName, osName }
}

function createDeviceFingerprint(req) {
  const userAgent = getUserAgent(req)
  const acceptLanguage = cleanText(req.headers['accept-language'], 250)

  return crypto
    .createHash('sha256')
    .update(`${userAgent}:${acceptLanguage}`)
    .digest('hex')
}

async function insertDeviceEvent(payload) {
  const { error } = await supabase
    .from('admin_device_events')
    .insert({
      admin_id: payload.admin_id || '',
      admin_email: normalizeEmail(payload.admin_email),
      device_id: payload.device_id || null,
      session_id: payload.session_id || null,
      event_type: payload.event_type || 'device_event',
      result: payload.result || 'success',
      reason: payload.reason || '',
      ip_address: payload.ip_address || '',
      user_agent: payload.user_agent || '',
      metadata: payload.metadata || {},
      created_at: new Date().toISOString(),
    })

  if (error) console.error('ADMIN DEVICE EVENT ERROR:', error)
}

async function insertSecurityAlert(payload) {
  const { error } = await supabase
    .from('admin_security_alerts')
    .insert({
      admin_id: payload.admin_id || '',
      admin_email: normalizeEmail(payload.admin_email),
      device_id: payload.device_id || null,
      session_id: payload.session_id || null,
      alert_type: payload.alert_type || 'security_alert',
      severity: payload.severity || 'medium',
      title: payload.title || '',
      message: payload.message || '',
      ip_address: payload.ip_address || '',
      user_agent: payload.user_agent || '',
      is_read: false,
      metadata: payload.metadata || {},
      created_at: new Date().toISOString(),
    })

  if (error) console.error('ADMIN SECURITY ALERT ERROR:', error)
}

async function getActiveDeviceByTokenHash(deviceTokenHash) {
  if (!deviceTokenHash) return null

  const { data, error } = await supabase
    .from('admin_devices')
    .select('*')
    .eq('device_token_hash', deviceTokenHash)
    .eq('status', 'active')
    .maybeSingle()

  if (error) throw error
  return data || null
}

async function getDeviceByTokenHash(deviceTokenHash) {
  if (!deviceTokenHash) return null

  const { data, error } = await supabase
    .from('admin_devices')
    .select('*')
    .eq('device_token_hash', deviceTokenHash)
    .maybeSingle()

  if (error) throw error
  return data || null
}

async function countActiveDevices(adminId, adminEmail) {
  let query = supabase
    .from('admin_devices')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'active')

  if (adminId) {
    query = query.eq('admin_id', adminId)
  } else {
    query = query.eq('admin_email', normalizeEmail(adminEmail))
  }

  const { count, error } = await query
  if (error) throw error

  return count || 0
}

async function reactivateDevice(device, req, admin) {
  const now = new Date().toISOString()
  const ipAddress = getAdminDeviceClientIp(req)
  const userAgent = getUserAgent(req)
  const { browserName, osName } = parseBrowser(userAgent)

  const { data, error } = await supabase
    .from('admin_devices')
    .update({
      status: 'active',
      admin_id: admin?.id || device.admin_id || '',
      admin_email: admin?.email || device.admin_email || '',
      browser_name: browserName,
      os_name: osName,
      last_ip: ipAddress,
      last_user_agent: userAgent,
      last_login_at: now,
      last_seen_at: now,
      logged_out_at: null,
      revoked_at: null,
      revoked_by: '',
      revoked_reason: '',
      updated_at: now,
    })
    .eq('id', device.id)
    .select()
    .single()

  if (error) throw error
  return data
}

async function createDevice({ req, admin, deviceToken, deviceTokenHash }) {
  const now = new Date().toISOString()
  const ipAddress = getAdminDeviceClientIp(req)
  const userAgent = getUserAgent(req)
  const { browserName, osName } = parseBrowser(userAgent)

  const { data, error } = await supabase
    .from('admin_devices')
    .insert({
      admin_id: admin?.id || '',
      admin_email: admin?.email || '',
      device_token_hash: deviceTokenHash,
      device_fingerprint: createDeviceFingerprint(req),
      device_label: `${browserName} on ${osName}`,
      browser_name: browserName,
      os_name: osName,
      last_ip: ipAddress,
      last_user_agent: userAgent,
      status: 'active',
      first_login_at: now,
      last_login_at: now,
      last_seen_at: now,
      created_at: now,
      updated_at: now,
    })
    .select()
    .single()

  if (error) throw error

  await insertDeviceEvent({
    admin_id: admin?.id || '',
    admin_email: admin?.email || '',
    device_id: data.id,
    event_type: 'new_device_registered',
    result: 'success',
    reason: 'New admin device registered',
    ip_address: ipAddress,
    user_agent: userAgent,
    metadata: {
      max_devices: MAX_ADMIN_ACTIVE_DEVICES,
      browser_name: browserName,
      os_name: osName,
    },
  })

  return data
}

async function createSession({ req, admin, device }) {
  const now = new Date()
  const expiresAt = new Date(now.getTime() + SESSION_DAYS * 24 * 60 * 60 * 1000)
  const sessionToken = randomToken()
  const jwtId = crypto.randomUUID()
  const ipAddress = getAdminDeviceClientIp(req)
  const userAgent = getUserAgent(req)

  const { data, error } = await supabase
    .from('admin_sessions')
    .insert({
      admin_id: admin?.id || '',
      admin_email: admin?.email || '',
      device_id: device.id,
      session_token_hash: hashToken(sessionToken),
      jwt_id: jwtId,
      ip_address: ipAddress,
      user_agent: userAgent,
      status: 'active',
      created_at: now.toISOString(),
      last_seen_at: now.toISOString(),
      expires_at: expiresAt.toISOString(),
    })
    .select()
    .single()

  if (error) throw error

  await insertDeviceEvent({
    admin_id: admin?.id || '',
    admin_email: admin?.email || '',
    device_id: device.id,
    session_id: data.id,
    event_type: 'device_login_success',
    result: 'success',
    reason: 'Admin login session created',
    ip_address: ipAddress,
    user_agent: userAgent,
    metadata: {
      jwt_id: jwtId,
      expires_at: expiresAt.toISOString(),
    },
  })

  return {
    session: data,
    session_token: sessionToken,
    jwt_id: jwtId,
    expires_at: expiresAt.toISOString(),
  }
}

export async function registerAdminDeviceSession({ req, res, admin }) {
  const ipAddress = getAdminDeviceClientIp(req)
  const userAgent = getUserAgent(req)
  const cookies = parseCookies(req)
  let deviceToken = cleanText(cookies[ADMIN_DEVICE_COOKIE], 300)
  let deviceTokenHash = deviceToken ? hashToken(deviceToken) : ''
  const adminId = admin?.id || ''
  const adminEmail = admin?.email || ''

  try {
    let device = await getActiveDeviceByTokenHash(deviceTokenHash)

    if (device && device.admin_id !== adminId && normalizeEmail(device.admin_email) !== normalizeEmail(adminEmail)) {
      device = null
    }

    if (!device) {
      const oldDevice = await getDeviceByTokenHash(deviceTokenHash)

      if (oldDevice && normalizeEmail(oldDevice.admin_email) === normalizeEmail(adminEmail)) {
        const activeCount = await countActiveDevices(adminId, adminEmail)

        if (activeCount >= MAX_ADMIN_ACTIVE_DEVICES) {
          await insertDeviceEvent({
            admin_id: adminId,
            admin_email: adminEmail,
            device_id: oldDevice.id,
            event_type: 'device_login_blocked_limit',
            result: 'blocked',
            reason: 'Admin active device limit reached',
            ip_address: ipAddress,
            user_agent: userAgent,
            metadata: { active_count: activeCount, max_devices: MAX_ADMIN_ACTIVE_DEVICES },
          })

          await insertSecurityAlert({
            admin_id: adminId,
            admin_email: adminEmail,
            device_id: oldDevice.id,
            alert_type: 'device_limit_reached',
            severity: 'high',
            title: 'Admin device limit reached',
            message: 'A logged out or revoked device tried to become active while the device limit was full.',
            ip_address: ipAddress,
            user_agent: userAgent,
            metadata: { active_count: activeCount, max_devices: MAX_ADMIN_ACTIVE_DEVICES },
          })

          return {
            allowed: false,
            code: 'ADMIN_DEVICE_LIMIT_REACHED',
            message: 'Device limit reached. Only 2 admin devices can be active. Revoke another device first.',
            active_devices: activeCount,
            max_devices: MAX_ADMIN_ACTIVE_DEVICES,
          }
        }

        device = await reactivateDevice(oldDevice, req, admin)
      }
    }

    if (!device) {
      const activeCount = await countActiveDevices(adminId, adminEmail)

      if (activeCount >= MAX_ADMIN_ACTIVE_DEVICES) {
        await insertDeviceEvent({
          admin_id: adminId,
          admin_email: adminEmail,
          event_type: 'new_device_blocked_limit',
          result: 'blocked',
          reason: 'Admin active device limit reached',
          ip_address: ipAddress,
          user_agent: userAgent,
          metadata: { active_count: activeCount, max_devices: MAX_ADMIN_ACTIVE_DEVICES },
        })

        await insertSecurityAlert({
          admin_id: adminId,
          admin_email: adminEmail,
          alert_type: 'new_device_blocked',
          severity: 'critical',
          title: 'New admin device blocked',
          message: 'A new device tried to login after the 2-device limit was already full.',
          ip_address: ipAddress,
          user_agent: userAgent,
          metadata: { active_count: activeCount, max_devices: MAX_ADMIN_ACTIVE_DEVICES },
        })

        return {
          allowed: false,
          code: 'ADMIN_DEVICE_LIMIT_REACHED',
          message: 'Device limit reached. Only 2 admin devices can be active. Revoke another device first.',
          active_devices: activeCount,
          max_devices: MAX_ADMIN_ACTIVE_DEVICES,
        }
      }

      deviceToken = randomToken()
      deviceTokenHash = hashToken(deviceToken)
      device = await createDevice({ req, admin, deviceToken, deviceTokenHash })
    }

    if (res?.cookie) {
      res.cookie(ADMIN_DEVICE_COOKIE, deviceToken, getCookieOptions())
    }

    const sessionInfo = await createSession({ req, admin, device })
    const activeDevices = await countActiveDevices(adminId, adminEmail)

    return {
      allowed: true,
      device_id: device.id,
      session_id: sessionInfo.session.id,
      jwt_id: sessionInfo.jwt_id,
      expires_at: sessionInfo.expires_at,
      device_label: device.device_label,
      active_devices: activeDevices,
      max_devices: MAX_ADMIN_ACTIVE_DEVICES,
    }
  } catch (error) {
    console.error('ADMIN DEVICE SESSION REGISTER ERROR:', error)

    await insertSecurityAlert({
      admin_id: adminId,
      admin_email: adminEmail,
      alert_type: 'device_access_error',
      severity: 'high',
      title: 'Admin device access check failed',
      message: error.message || 'Admin device access failed during login.',
      ip_address: ipAddress,
      user_agent: userAgent,
    })

    return {
      allowed: false,
      code: 'ADMIN_DEVICE_ACCESS_ERROR',
      message: 'Admin device access check failed. Please try again.',
      active_devices: 0,
      max_devices: MAX_ADMIN_ACTIVE_DEVICES,
    }
  }
}

export async function validateAdminSession({ decoded, req }) {
  const sessionId = decoded?.session_id || ''
  const deviceId = decoded?.device_id || ''
  const jwtId = decoded?.jwt_id || decoded?.jti || ''

  if (!sessionId || !deviceId || !jwtId) {
    return {
      ok: false,
      status: 401,
      code: 'ADMIN_SESSION_REQUIRED',
      message: 'Admin session is required. Please login again.',
    }
  }

  const { data: session, error: sessionError } = await supabase
    .from('admin_sessions')
    .select('*')
    .eq('id', sessionId)
    .eq('jwt_id', jwtId)
    .eq('status', 'active')
    .maybeSingle()

  if (sessionError) throw sessionError

  if (!session) {
    return {
      ok: false,
      status: 401,
      code: 'ADMIN_SESSION_REVOKED',
      message: 'Admin session was logged out or revoked. Please login again.',
    }
  }

  if (new Date(session.expires_at).getTime() <= Date.now()) {
    await supabase
      .from('admin_sessions')
      .update({
        status: 'expired',
        revoked_reason: 'Session expired',
      })
      .eq('id', session.id)

    return {
      ok: false,
      status: 401,
      code: 'ADMIN_SESSION_EXPIRED',
      message: 'Admin session expired. Please login again.',
    }
  }

  const { data: device, error: deviceError } = await supabase
    .from('admin_devices')
    .select('*')
    .eq('id', deviceId)
    .eq('status', 'active')
    .maybeSingle()

  if (deviceError) throw deviceError

  if (!device) {
    await supabase
      .from('admin_sessions')
      .update({
        status: 'revoked',
        revoked_at: new Date().toISOString(),
        revoked_by: 'system',
        revoked_reason: 'Device is not active',
      })
      .eq('id', session.id)

    return {
      ok: false,
      status: 401,
      code: 'ADMIN_DEVICE_REVOKED',
      message: 'Admin device was logged out or revoked. Please login again.',
    }
  }

  const now = new Date().toISOString()
  const ipAddress = getAdminDeviceClientIp(req)
  const userAgent = getUserAgent(req)

  await Promise.all([
    supabase
      .from('admin_sessions')
      .update({
        last_seen_at: now,
        ip_address: ipAddress,
        user_agent: userAgent,
      })
      .eq('id', session.id),
    supabase
      .from('admin_devices')
      .update({
        last_seen_at: now,
        last_ip: ipAddress,
        last_user_agent: userAgent,
        updated_at: now,
      })
      .eq('id', device.id),
  ])

  return {
    ok: true,
    session,
    device,
  }
}

export async function listAdminDevices({ admin }) {
  const adminId = admin?.admin_id || admin?.id || ''
  const adminEmail = admin?.email || ''

  let query = supabase
    .from('admin_devices')
    .select('*')
    .order('updated_at', { ascending: false })

  if (adminId) query = query.eq('admin_id', adminId)
  else query = query.eq('admin_email', normalizeEmail(adminEmail))

  const { data, error } = await query
  if (error) throw error

  const activeCount = (data || []).filter((device) => device.status === 'active').length

  return {
    devices: data || [],
    active_devices: activeCount,
    max_devices: MAX_ADMIN_ACTIVE_DEVICES,
  }
}

export async function logoutCurrentAdminDevice({ admin, req }) {
  const sessionId = admin?.session_id || ''
  const deviceId = admin?.device_id || ''
  const now = new Date().toISOString()
  const ipAddress = getAdminDeviceClientIp(req)
  const userAgent = getUserAgent(req)

  if (!sessionId || !deviceId) {
    return {
      ok: false,
      status: 400,
      message: 'Current session or device is missing',
    }
  }

  await supabase
    .from('admin_sessions')
    .update({
      status: 'logged_out',
      logged_out_at: now,
    })
    .eq('id', sessionId)

  await supabase
    .from('admin_devices')
    .update({
      status: 'logged_out',
      logged_out_at: now,
      last_seen_at: now,
      updated_at: now,
    })
    .eq('id', deviceId)

  await insertDeviceEvent({
    admin_id: admin?.admin_id || '',
    admin_email: admin?.email || '',
    device_id: deviceId,
    session_id: sessionId,
    event_type: 'device_logout_current',
    result: 'logged_out',
    reason: 'Admin logged out this device',
    ip_address: ipAddress,
    user_agent: userAgent,
  })

  return {
    ok: true,
    message: 'Current admin device logged out',
  }
}

export async function revokeAdminDeviceById({ admin, req, deviceId, reason }) {
  const currentDeviceId = admin?.device_id || ''

  if (!deviceId || !/^[0-9a-f-]{36}$/i.test(deviceId)) {
    return {
      ok: false,
      status: 400,
      message: 'Invalid device ID',
    }
  }

  if (deviceId === currentDeviceId) {
    return {
      ok: false,
      status: 400,
      message: 'Use Logout this device for the current device.',
    }
  }

  const adminId = admin?.admin_id || ''
  const adminEmail = admin?.email || ''

  const { data: device, error: deviceError } = await supabase
    .from('admin_devices')
    .select('*')
    .eq('id', deviceId)
    .maybeSingle()

  if (deviceError) throw deviceError

  if (!device) {
    return {
      ok: false,
      status: 404,
      message: 'Device not found',
    }
  }

  if (adminId && device.admin_id !== adminId) {
    return {
      ok: false,
      status: 403,
      message: 'This device does not belong to the current admin.',
    }
  }

  if (!adminId && normalizeEmail(device.admin_email) !== normalizeEmail(adminEmail)) {
    return {
      ok: false,
      status: 403,
      message: 'This device does not belong to the current admin.',
    }
  }

  const now = new Date().toISOString()
  const ipAddress = getAdminDeviceClientIp(req)
  const userAgent = getUserAgent(req)
  const cleanReason = cleanText(reason || 'Revoked by admin', 500)

  await supabase
    .from('admin_sessions')
    .update({
      status: 'revoked',
      revoked_at: now,
      revoked_by: adminEmail || adminId || 'admin',
      revoked_reason: cleanReason,
    })
    .eq('device_id', deviceId)
    .eq('status', 'active')

  const { data: updated, error: updateError } = await supabase
    .from('admin_devices')
    .update({
      status: 'revoked',
      revoked_at: now,
      revoked_by: adminEmail || adminId || 'admin',
      revoked_reason: cleanReason,
      updated_at: now,
    })
    .eq('id', deviceId)
    .select()
    .single()

  if (updateError) throw updateError

  await insertDeviceEvent({
    admin_id: adminId,
    admin_email: adminEmail,
    device_id: deviceId,
    event_type: 'device_revoked',
    result: 'revoked',
    reason: cleanReason,
    ip_address: ipAddress,
    user_agent: userAgent,
    metadata: { revoked_device_label: device.device_label || '' },
  })

  await insertSecurityAlert({
    admin_id: adminId,
    admin_email: adminEmail,
    device_id: deviceId,
    alert_type: 'trusted_device_revoked',
    severity: 'medium',
    title: 'Admin device revoked',
    message: `An admin device was revoked: ${device.device_label || deviceId}`,
    ip_address: ipAddress,
    user_agent: userAgent,
    metadata: { reason: cleanReason },
  })

  return {
    ok: true,
    device: updated,
    message: 'Admin device revoked',
  }
}

export async function listAdminDeviceEvents({ admin, limit = 30 }) {
  const adminId = admin?.admin_id || admin?.id || ''
  const adminEmail = admin?.email || ''
  const safeLimit = Math.min(Math.max(Number(limit || 30), 1), 100)

  let query = supabase
    .from('admin_device_events')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(safeLimit)

  if (adminId) query = query.eq('admin_id', adminId)
  else query = query.eq('admin_email', normalizeEmail(adminEmail))

  const { data, error } = await query
  if (error) throw error

  return data || []
}

export async function emergencyResetAdminDevices({ admin, req }) {
  const adminEmail = admin?.email || ''

  if (!adminEmail) {
    return {
      ok: false,
      status: 400,
      message: 'Admin email missing',
    }
  }

  const { data, error } = await supabase.rpc('admin_emergency_reset_devices', {
    p_admin_email: adminEmail,
  })

  if (error) throw error

  await insertSecurityAlert({
    admin_id: admin?.admin_id || '',
    admin_email: adminEmail,
    alert_type: 'emergency_device_reset',
    severity: 'critical',
    title: 'Emergency admin device reset',
    message: 'All admin devices and sessions were reset from the admin account.',
    ip_address: getAdminDeviceClientIp(req),
    user_agent: getUserAgent(req),
  })

  return {
    ok: true,
    result: Array.isArray(data) ? data[0] : data,
  }
}
