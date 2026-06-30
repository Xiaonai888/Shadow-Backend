import crypto from 'crypto'
import { supabase } from '../config/supabase.js'
import {
  createAdminSecurityAlert,
  getAdminRequestCountry,
  getAdminSecurityClientIp,
} from './adminSecurityAlerts.service.js'
import { verifyAdminTwoFactorCode } from './adminTwoFactor.service.js'

const PIN_LENGTH = 6
const HASH_ITERATIONS = 120000
const LOCK_AFTER_ATTEMPTS = 5
const LOCK_MINUTES = 15

function cleanText(value, maxLength = 500) {
  return String(value || '').trim().slice(0, maxLength)
}

function normalizeEmail(value) {
  return cleanText(value, 320).toLowerCase()
}

function getAdminIdentity(admin = {}) {
  return {
    adminId: cleanText(admin?.admin_id || admin?.id || '', 120),
    adminEmail: normalizeEmail(admin?.email || ''),
  }
}

function getUserAgent(req) {
  return cleanText(req.headers['user-agent'], 1000)
}

function isValidPin(pin) {
  return new RegExp(`^\\d{${PIN_LENGTH}}$`).test(String(pin || '').trim())
}

function hashPin({ adminEmail, pin, salt = crypto.randomBytes(16).toString('hex') }) {
  const hash = crypto
    .pbkdf2Sync(`${normalizeEmail(adminEmail)}:${String(pin || '').trim()}`, salt, HASH_ITERATIONS, 32, 'sha256')
    .toString('hex')

  return `pbkdf2_sha256$${HASH_ITERATIONS}$${salt}$${hash}`
}

function verifyPinHash({ adminEmail, pin, pinHash }) {
  const parts = String(pinHash || '').split('$')

  if (parts.length !== 4) return false

  const [scheme, iterationsText, salt, expectedHash] = parts

  if (scheme !== 'pbkdf2_sha256') return false

  const iterations = Number(iterationsText || 0)

  if (!iterations || !salt || !expectedHash) return false

  const actualHash = crypto
    .pbkdf2Sync(`${normalizeEmail(adminEmail)}:${String(pin || '').trim()}`, salt, iterations, 32, 'sha256')
    .toString('hex')

  const actual = Buffer.from(actualHash, 'hex')
  const expected = Buffer.from(expectedHash, 'hex')

  if (actual.length !== expected.length) return false

  return crypto.timingSafeEqual(actual, expected)
}

function formatStatus(settings) {
  return {
    is_enabled: Boolean(settings?.is_enabled),
    failed_count: Number(settings?.failed_count || 0),
    locked_until: settings?.locked_until || null,
    last_verified_at: settings?.last_verified_at || null,
    last_changed_at: settings?.last_changed_at || null,
    disabled_at: settings?.disabled_at || null,
  }
}

function isLocked(settings) {
  return settings?.locked_until && new Date(settings.locked_until).getTime() > Date.now()
}

function lockSeconds(settings) {
  if (!settings?.locked_until) return 0
  return Math.max(0, Math.ceil((new Date(settings.locked_until).getTime() - Date.now()) / 1000))
}

async function insertPasskeyPinEvent({ admin, req, eventType, result = 'success', reason = '', metadata = {} }) {
  const { adminId, adminEmail } = getAdminIdentity(admin)
  const country = getAdminRequestCountry(req)

  const { error } = await supabase
    .from('admin_passkey_pin_events')
    .insert({
      admin_id: adminId,
      admin_email: adminEmail,
      event_type: eventType,
      result,
      reason,
      ip_address: getAdminSecurityClientIp(req),
      user_agent: getUserAgent(req),
      country_code: country.country_code,
      country_name: country.country_name,
      metadata,
      created_at: new Date().toISOString(),
    })

  if (error) console.error('ADMIN PASSKEY PIN EVENT ERROR:', error)
}

async function getSettings(admin) {
  const { adminId, adminEmail } = getAdminIdentity(admin)

  if (!adminEmail) {
    throw new Error('Admin email missing')
  }

  const { data, error } = await supabase
    .from('admin_passkey_pin_settings')
    .select('*')
    .eq('admin_email', adminEmail)
    .maybeSingle()

  if (error) throw error

  if (data) return data

  const now = new Date().toISOString()

  const { data: inserted, error: insertError } = await supabase
    .from('admin_passkey_pin_settings')
    .insert({
      admin_id: adminId,
      admin_email: adminEmail,
      created_at: now,
      updated_at: now,
    })
    .select()
    .single()

  if (insertError) throw insertError

  return inserted
}

async function updateSettings(admin, payload) {
  const { adminId, adminEmail } = getAdminIdentity(admin)
  const now = new Date().toISOString()

  const { data, error } = await supabase
    .from('admin_passkey_pin_settings')
    .upsert({
      admin_id: adminId,
      admin_email: adminEmail,
      ...payload,
      updated_at: now,
    }, { onConflict: 'admin_email' })
    .select()
    .single()

  if (error) throw error

  return data
}

async function verifyCurrentTwoFactor({ admin, code }) {
  const cleanCode = cleanText(code, 80)

  if (!cleanCode) {
    return {
      ok: false,
      status: 400,
      message: '2FA code is required',
    }
  }

  const verified = await verifyAdminTwoFactorCode({
    admin,
    code: cleanCode,
    allowRecovery: true,
  })

  if (!verified.ok) {
    return {
      ok: false,
      status: 400,
      message: '2FA code is incorrect',
    }
  }

  return {
    ok: true,
    method: verified.method,
  }
}

export async function getAdminPasskeyPinStatus({ admin }) {
  const settings = await getSettings(admin)

  return formatStatus(settings)
}

export async function setupAdminPasskeyPin({ admin, req, pin, confirmPin, twoFactorCode }) {
  const { adminEmail } = getAdminIdentity(admin)
  const cleanPin = cleanText(pin, 20)
  const cleanConfirmPin = cleanText(confirmPin, 20)

  if (!isValidPin(cleanPin)) {
    return {
      ok: false,
      status: 400,
      message: 'Passkey PIN must be exactly 6 digits',
    }
  }

  if (cleanPin !== cleanConfirmPin) {
    return {
      ok: false,
      status: 400,
      message: 'Passkey PIN and confirm PIN do not match',
    }
  }

  const twoFactor = await verifyCurrentTwoFactor({ admin, code: twoFactorCode })

  if (!twoFactor.ok) {
    await createAdminSecurityAlert({
      req,
      admin,
      alertType: 'passkey_pin_setup_failed',
      severity: 'high',
      title: 'Failed passkey PIN setup attempt',
      message: 'A wrong 2FA code was used while trying to set admin passkey PIN.',
    })

    return twoFactor
  }

  const now = new Date().toISOString()
  const updated = await updateSettings(admin, {
    pin_hash: hashPin({ adminEmail, pin: cleanPin }),
    is_enabled: true,
    failed_count: 0,
    locked_until: null,
    last_changed_at: now,
    disabled_at: null,
  })

  await insertPasskeyPinEvent({
    admin,
    req,
    eventType: 'passkey_pin_enabled',
    result: 'success',
    reason: 'Admin passkey PIN enabled',
    metadata: {
      two_factor_method: twoFactor.method,
    },
  })

  await createAdminSecurityAlert({
    req,
    admin,
    alertType: 'passkey_pin_enabled',
    severity: 'low',
    title: 'Admin passkey PIN enabled',
    message: 'Admin passkey PIN was enabled for this account.',
  })

  return {
    ok: true,
    status: formatStatus(updated),
  }
}

export async function verifyAdminPasskeyPin({ admin, req, pin, purpose = 'admin_action' }) {
  const settings = await getSettings(admin)
  const { adminEmail } = getAdminIdentity(admin)
  const cleanPin = cleanText(pin, 20)

  if (!settings.is_enabled || !settings.pin_hash) {
    return {
      ok: false,
      status: 400,
      message: 'Admin passkey PIN is not enabled',
    }
  }

  if (isLocked(settings)) {
    await insertPasskeyPinEvent({
      admin,
      req,
      eventType: 'passkey_pin_locked_hit',
      result: 'blocked',
      reason: 'Admin passkey PIN is temporarily locked',
      metadata: {
        purpose,
        locked_until: settings.locked_until,
      },
    })

    return {
      ok: false,
      status: 423,
      code: 'PASSKEY_PIN_LOCKED',
      message: 'Admin passkey PIN is temporarily locked',
      locked_until: settings.locked_until,
      retry_after_seconds: lockSeconds(settings),
    }
  }

  if (!isValidPin(cleanPin) || !verifyPinHash({ adminEmail, pin: cleanPin, pinHash: settings.pin_hash })) {
    const nextFailedCount = Number(settings.failed_count || 0) + 1
    const shouldLock = nextFailedCount >= LOCK_AFTER_ATTEMPTS
    const lockedUntil = shouldLock
      ? new Date(Date.now() + LOCK_MINUTES * 60 * 1000).toISOString()
      : null

    await updateSettings(admin, {
      failed_count: nextFailedCount,
      locked_until: lockedUntil,
    })

    await insertPasskeyPinEvent({
      admin,
      req,
      eventType: shouldLock ? 'passkey_pin_locked' : 'passkey_pin_failed',
      result: shouldLock ? 'blocked' : 'failed',
      reason: shouldLock ? 'Too many wrong passkey PIN attempts' : 'Wrong passkey PIN',
      metadata: {
        purpose,
        failed_count: nextFailedCount,
        locked_until: lockedUntil,
      },
    })

    await createAdminSecurityAlert({
      req,
      admin,
      alertType: shouldLock ? 'passkey_pin_locked' : 'passkey_pin_failed',
      severity: shouldLock || nextFailedCount >= 3 ? 'high' : 'medium',
      title: shouldLock ? 'Admin passkey PIN locked' : 'Wrong admin passkey PIN',
      message: shouldLock
        ? 'Admin passkey PIN was locked after too many wrong attempts.'
        : 'A wrong admin passkey PIN was entered.',
      metadata: {
        purpose,
        failed_count: nextFailedCount,
        locked_until: lockedUntil,
      },
    })

    return {
      ok: false,
      status: shouldLock ? 423 : 400,
      code: shouldLock ? 'PASSKEY_PIN_LOCKED' : 'PASSKEY_PIN_INCORRECT',
      message: shouldLock ? 'Too many wrong attempts. Passkey PIN is temporarily locked.' : 'Passkey PIN is incorrect',
      attempts_left: Math.max(0, LOCK_AFTER_ATTEMPTS - nextFailedCount),
      locked_until: lockedUntil,
    }
  }

  const now = new Date().toISOString()
  const updated = await updateSettings(admin, {
    failed_count: 0,
    locked_until: null,
    last_verified_at: now,
  })

  await insertPasskeyPinEvent({
    admin,
    req,
    eventType: 'passkey_pin_verified',
    result: 'success',
    reason: 'Admin passkey PIN verified',
    metadata: {
      purpose,
    },
  })

  return {
    ok: true,
    status: formatStatus(updated),
  }
}

export async function changeAdminPasskeyPin({ admin, req, currentPin, newPin, confirmPin }) {
  const cleanNewPin = cleanText(newPin, 20)
  const cleanConfirmPin = cleanText(confirmPin, 20)

  if (!isValidPin(cleanNewPin)) {
    return {
      ok: false,
      status: 400,
      message: 'New passkey PIN must be exactly 6 digits',
    }
  }

  if (cleanNewPin !== cleanConfirmPin) {
    return {
      ok: false,
      status: 400,
      message: 'New passkey PIN and confirm PIN do not match',
    }
  }

  const verified = await verifyAdminPasskeyPin({
    admin,
    req,
    pin: currentPin,
    purpose: 'change_passkey_pin',
  })

  if (!verified.ok) return verified

  const { adminEmail } = getAdminIdentity(admin)
  const now = new Date().toISOString()
  const updated = await updateSettings(admin, {
    pin_hash: hashPin({ adminEmail, pin: cleanNewPin }),
    failed_count: 0,
    locked_until: null,
    last_changed_at: now,
  })

  await insertPasskeyPinEvent({
    admin,
    req,
    eventType: 'passkey_pin_changed',
    result: 'success',
    reason: 'Admin passkey PIN changed',
  })

  await createAdminSecurityAlert({
    req,
    admin,
    alertType: 'passkey_pin_changed',
    severity: 'low',
    title: 'Admin passkey PIN changed',
    message: 'Admin passkey PIN was changed.',
  })

  return {
    ok: true,
    status: formatStatus(updated),
  }
}

export async function disableAdminPasskeyPin({ admin, req, pin }) {
  const verified = await verifyAdminPasskeyPin({
    admin,
    req,
    pin,
    purpose: 'disable_passkey_pin',
  })

  if (!verified.ok) return verified

  const now = new Date().toISOString()
  const updated = await updateSettings(admin, {
    pin_hash: '',
    is_enabled: false,
    failed_count: 0,
    locked_until: null,
    disabled_at: now,
    last_changed_at: now,
  })

  await insertPasskeyPinEvent({
    admin,
    req,
    eventType: 'passkey_pin_disabled',
    result: 'success',
    reason: 'Admin passkey PIN disabled',
  })

  await createAdminSecurityAlert({
    req,
    admin,
    alertType: 'passkey_pin_disabled',
    severity: 'medium',
    title: 'Admin passkey PIN disabled',
    message: 'Admin passkey PIN was disabled.',
  })

  return {
    ok: true,
    status: formatStatus(updated),
  }
}

export async function listAdminPasskeyPinEvents({ admin, limit = 30 }) {
  const { adminId, adminEmail } = getAdminIdentity(admin)
  const safeLimit = Math.min(Math.max(Number(limit || 30), 1), 100)

  let query = supabase
    .from('admin_passkey_pin_events')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(safeLimit)

  if (adminId && adminEmail) query = query.or(`admin_id.eq.${adminId},admin_email.eq.${adminEmail}`)
  else if (adminId) query = query.eq('admin_id', adminId)
  else query = query.eq('admin_email', adminEmail)

  const { data, error } = await query

  if (error) throw error

  return data || []
}

export async function shouldRequireAdminPasskeyPin({ admin }) {
  const settings = await getSettings(admin)

  return Boolean(settings.is_enabled && settings.pin_hash)
}

export async function getAdminPasskeyPinLoginState({ admin }) {
  const settings = await getSettings(admin)
  const required = Boolean(settings.is_enabled && settings.pin_hash)
  const locked = required && Boolean(isLocked(settings))

  return {
    required,
    locked,
    locked_until: locked ? settings.locked_until : null,
    retry_after_seconds: locked ? lockSeconds(settings) : 0,
    failed_count: Number(settings.failed_count || 0),
    status: formatStatus(settings),
  }
}

export async function verifyAdminPasskeyPinForLogin({ admin, req, pin }) {
  return verifyAdminPasskeyPin({
    admin,
    req,
    pin,
    purpose: 'admin_login',
  })
}
