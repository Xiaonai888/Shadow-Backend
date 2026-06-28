import crypto from 'crypto'
import { supabase } from '../config/supabase.js'
import {
  createAdminSecurityAlert,
  getAdminRequestCountry,
  getAdminSecurityClientIp,
} from './adminSecurityAlerts.service.js'

const ISSUER = 'Shadow Admin'
const TOTP_STEP_SECONDS = 30
const TOTP_DIGITS = 6
const TOTP_WINDOW = 1
const SETUP_EXPIRES_MINUTES = 10
const RECOVERY_CODE_COUNT = 10

function cleanText(value, maxLength = 500) {
  return String(value || '').trim().slice(0, maxLength)
}

function isValidUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''))
}

function normalizeEmail(value) {
  return cleanText(value, 320).toLowerCase()
}

function getAdminIdentity(admin = {}) {
  return {
    adminId: admin?.admin_id || admin?.id || '',
    adminEmail: normalizeEmail(admin?.email || ''),
  }
}

function getUserAgent(req) {
  return cleanText(req.headers['user-agent'], 1000)
}

function getCryptoKey() {
  const secret = String(
    process.env.TWO_FACTOR_SECRET_KEY
    || process.env.JWT_SECRET
    || process.env.SUPABASE_SERVICE_ROLE_KEY
    || ''
  ).trim()

  if (!secret) {
    throw new Error('TWO_FACTOR_SECRET_KEY or JWT_SECRET is required')
  }

  return crypto.createHash('sha256').update(secret).digest()
}

function encryptText(value) {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', getCryptoKey(), iv)
  const encrypted = Buffer.concat([cipher.update(String(value || ''), 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()

  return `${iv.toString('base64')}.${tag.toString('base64')}.${encrypted.toString('base64')}`
}

function decryptText(value) {
  const text = String(value || '')
  const parts = text.split('.')

  if (parts.length !== 3) return ''

  const [ivText, tagText, encryptedText] = parts
  const decipher = crypto.createDecipheriv('aes-256-gcm', getCryptoKey(), Buffer.from(ivText, 'base64'))
  decipher.setAuthTag(Buffer.from(tagText, 'base64'))

  return Buffer.concat([
    decipher.update(Buffer.from(encryptedText, 'base64')),
    decipher.final(),
  ]).toString('utf8')
}

const base32Alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

function encodeBase32(buffer) {
  let bits = ''
  let output = ''

  for (const byte of buffer) {
    bits += byte.toString(2).padStart(8, '0')
  }

  for (let index = 0; index < bits.length; index += 5) {
    const chunk = bits.slice(index, index + 5).padEnd(5, '0')
    output += base32Alphabet[parseInt(chunk, 2)]
  }

  return output
}

function decodeBase32(value) {
  const clean = String(value || '').replace(/=+$/g, '').replace(/\s+/g, '').toUpperCase()
  let bits = ''

  for (const char of clean) {
    const index = base32Alphabet.indexOf(char)
    if (index < 0) continue
    bits += index.toString(2).padStart(5, '0')
  }

  const bytes = []

  for (let index = 0; index + 8 <= bits.length; index += 8) {
    bytes.push(parseInt(bits.slice(index, index + 8), 2))
  }

  return Buffer.from(bytes)
}

function randomSecret() {
  return encodeBase32(crypto.randomBytes(20))
}

function timingSafeEqualText(left, right) {
  const a = Buffer.from(String(left || ''))
  const b = Buffer.from(String(right || ''))

  if (a.length !== b.length) return false

  return crypto.timingSafeEqual(a, b)
}

function generateTotp(secret, timeStep = Math.floor(Date.now() / 1000 / TOTP_STEP_SECONDS)) {
  const key = decodeBase32(secret)
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(timeStep))

  const hmac = crypto.createHmac('sha1', key).update(counter).digest()
  const offset = hmac[hmac.length - 1] & 0x0f
  const binary = ((hmac[offset] & 0x7f) << 24)
    | ((hmac[offset + 1] & 0xff) << 16)
    | ((hmac[offset + 2] & 0xff) << 8)
    | (hmac[offset + 3] & 0xff)

  return String(binary % (10 ** TOTP_DIGITS)).padStart(TOTP_DIGITS, '0')
}

function verifyTotp(secret, code) {
  const cleanCode = cleanText(code, 20).replace(/\s+/g, '')

  if (!/^\d{6}$/.test(cleanCode)) return false

  const currentStep = Math.floor(Date.now() / 1000 / TOTP_STEP_SECONDS)

  for (let offset = -TOTP_WINDOW; offset <= TOTP_WINDOW; offset += 1) {
    const expected = generateTotp(secret, currentStep + offset)

    if (timingSafeEqualText(expected, cleanCode)) return true
  }

  return false
}

function hashCode(email, code) {
  return crypto
    .createHash('sha256')
    .update(`${normalizeEmail(email)}:${String(code || '').trim().toUpperCase()}`)
    .digest('hex')
}

function createRecoveryCode() {
  const raw = encodeBase32(crypto.randomBytes(10)).slice(0, 16)
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}`
}

function buildOtpAuthUrl({ adminEmail, secret }) {
  const label = encodeURIComponent(`${ISSUER}:${adminEmail}`)
  const issuer = encodeURIComponent(ISSUER)

  return `otpauth://totp/${label}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_STEP_SECONDS}`
}

async function insertTwoFactorEvent({ admin, req, eventType, result = 'success', reason = '', metadata = {} }) {
  const { adminId, adminEmail } = getAdminIdentity(admin)
  const country = getAdminRequestCountry(req)

  const { error } = await supabase
    .from('admin_two_factor_events')
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

  if (error) console.error('ADMIN TWO FACTOR EVENT ERROR:', error)
}

async function getSettings(admin) {
  const { adminId, adminEmail } = getAdminIdentity(admin)

  if (!adminEmail) {
    throw new Error('Admin email missing')
  }

  const { data, error } = await supabase
    .from('admin_two_factor_settings')
    .select('*')
    .eq('admin_email', adminEmail)
    .maybeSingle()

  if (error) throw error

  if (data) return data

  const now = new Date().toISOString()
  const { data: inserted, error: insertError } = await supabase
    .from('admin_two_factor_settings')
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
    .from('admin_two_factor_settings')
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

async function createRecoveryCodes(admin) {
  const { adminId, adminEmail } = getAdminIdentity(admin)
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () => createRecoveryCode())
  const now = new Date().toISOString()

  await supabase
    .from('admin_recovery_codes')
    .delete()
    .eq('admin_email', adminEmail)

  const rows = codes.map((code) => ({
    admin_id: adminId,
    admin_email: adminEmail,
    code_hash: hashCode(adminEmail, code),
    code_hint: code.slice(-4),
    is_used: false,
    created_at: now,
  }))

  const { error } = await supabase
    .from('admin_recovery_codes')
    .insert(rows)

  if (error) throw error

  return codes
}

async function countRecoveryCodes(admin) {
  const { adminEmail } = getAdminIdentity(admin)

  const { count, error } = await supabase
    .from('admin_recovery_codes')
    .select('id', { count: 'exact', head: true })
    .eq('admin_email', adminEmail)
    .eq('is_used', false)

  if (error) throw error

  return count || 0
}

function formatStatus(settings, recoveryCodesRemaining = 0) {
  return {
    authenticator_enabled: Boolean(settings.authenticator_enabled),
    email_otp_enabled: Boolean(settings.email_otp_enabled),
    recovery_codes_enabled: Boolean(settings.recovery_codes_enabled),
    recovery_codes_remaining: recoveryCodesRemaining,
    last_verified_at: settings.last_verified_at,
    last_changed_at: settings.last_changed_at,
    recovery_codes_generated_at: settings.recovery_codes_generated_at,
  }
}

export async function getAdminTwoFactorStatus({ admin }) {
  const settings = await getSettings(admin)
  const recoveryCodesRemaining = await countRecoveryCodes(admin)

  return formatStatus(settings, recoveryCodesRemaining)
}

export async function startAdminAuthenticatorSetup({ admin, req }) {
  const { adminId, adminEmail } = getAdminIdentity(admin)
  const secret = randomSecret()
  const encryptedSecret = encryptText(secret)
  const country = getAdminRequestCountry(req)
  const now = new Date()
  const expiresAt = new Date(now.getTime() + SETUP_EXPIRES_MINUTES * 60 * 1000).toISOString()

  await getSettings(admin)

  await supabase
    .from('admin_two_factor_challenges')
    .update({
      status: 'cancelled',
      updated_at: now.toISOString(),
    })
    .eq('admin_email', adminEmail)
    .eq('purpose', 'setup')
    .eq('status', 'pending')

  const { data, error } = await supabase
    .from('admin_two_factor_challenges')
    .insert({
      admin_id: adminId,
      admin_email: adminEmail,
      challenge_type: 'authenticator',
      purpose: 'setup',
      status: 'pending',
      temp_secret_encrypted: encryptedSecret,
      ip_address: getAdminSecurityClientIp(req),
      user_agent: getUserAgent(req),
      country_code: country.country_code,
      country_name: country.country_name,
      expires_at: expiresAt,
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
    })
    .select()
    .single()

  if (error) throw error

  await insertTwoFactorEvent({
    admin,
    req,
    eventType: 'authenticator_setup_started',
    result: 'pending',
    reason: 'Authenticator setup started',
  })

  const settings = await getSettings(admin)

return {
  challenge_id: data.id,
  expires_at: expiresAt,
  methods: settings.email_otp_enabled
    ? ['authenticator', 'recovery_code', 'email_code']
    : ['authenticator', 'recovery_code'],
}
  
export async function verifyAdminAuthenticatorSetup({ admin, req, challengeId, code }) {
  const { adminEmail } = getAdminIdentity(admin)
  const cleanChallengeId = cleanText(challengeId, 80)
  const now = new Date().toISOString()

  if (!isValidUuid(cleanChallengeId)) {
  return {
    ok: false,
    status: 400,
    message: 'Invalid 2FA challenge ID',
  }
}

  const { data: challenge, error } = await supabase
    .from('admin_two_factor_challenges')
    .select('*')
    .eq('id', cleanChallengeId)
    .eq('admin_email', adminEmail)
    .eq('purpose', 'setup')
    .eq('status', 'pending')
    .maybeSingle()

  if (error) throw error

  if (!challenge) {
    return {
      ok: false,
      status: 404,
      message: 'Setup challenge not found or already used',
    }
  }

  if (new Date(challenge.expires_at).getTime() <= Date.now()) {
    await supabase
      .from('admin_two_factor_challenges')
      .update({ status: 'expired', updated_at: now })
      .eq('id', challenge.id)

    return {
      ok: false,
      status: 400,
      message: 'Setup challenge expired. Please start again.',
    }
  }

  const secret = decryptText(challenge.temp_secret_encrypted)
  const valid = verifyTotp(secret, code)
  const attemptCount = Number(challenge.attempt_count || 0) + 1

  if (!valid) {
    const failedStatus = attemptCount >= Number(challenge.max_attempts || 5) ? 'failed' : 'pending'

    await supabase
      .from('admin_two_factor_challenges')
      .update({
        attempt_count: attemptCount,
        status: failedStatus,
        updated_at: now,
      })
      .eq('id', challenge.id)

    await createAdminSecurityAlert({
      req,
      admin,
      alertType: 'two_factor_setup_failed',
      severity: attemptCount >= 3 ? 'medium' : 'low',
      title: '2FA setup verification failed',
      message: 'An admin entered a wrong authenticator setup code.',
      metadata: { attempt_count: attemptCount },
    })

    return {
      ok: false,
      status: 400,
      message: 'Authenticator code is incorrect',
      attempts_left: Math.max(0, Number(challenge.max_attempts || 5) - attemptCount),
    }
  }

  const recoveryCodes = await createRecoveryCodes(admin)

  const settings = await updateSettings(admin, {
    authenticator_enabled: true,
    authenticator_secret_encrypted: challenge.temp_secret_encrypted,
    recovery_codes_enabled: true,
    recovery_codes_generated_at: now,
    last_verified_at: now,
    last_changed_at: now,
    disabled_at: null,
  })

  await supabase
    .from('admin_two_factor_challenges')
    .update({
      status: 'verified',
      verified_at: now,
      updated_at: now,
    })
    .eq('id', challenge.id)

  await insertTwoFactorEvent({
    admin,
    req,
    eventType: 'authenticator_enabled',
    result: 'success',
    reason: 'Authenticator 2FA enabled',
  })

  return {
    ok: true,
    status: formatStatus(settings, recoveryCodes.length),
    recovery_codes: recoveryCodes,
  }
}

export async function verifyAdminTwoFactorCode({ admin, code, allowRecovery = true }) {
  const { adminEmail } = getAdminIdentity(admin)
  const settings = await getSettings(admin)
  const cleanCode = cleanText(code, 50).replace(/\s+/g, '').toUpperCase()

  if (settings.authenticator_enabled && settings.authenticator_secret_encrypted) {
    const secret = decryptText(settings.authenticator_secret_encrypted)

    if (verifyTotp(secret, cleanCode)) {
      return { ok: true, method: 'authenticator' }
    }
  }

  if (allowRecovery && settings.recovery_codes_enabled) {
    const recoveryHash = hashCode(adminEmail, cleanCode)

    const { data: recoveryCode, error } = await supabase
      .from('admin_recovery_codes')
      .select('*')
      .eq('admin_email', adminEmail)
      .eq('code_hash', recoveryHash)
      .eq('is_used', false)
      .maybeSingle()

    if (error) throw error

    if (recoveryCode) {
      await supabase
        .from('admin_recovery_codes')
        .update({
          is_used: true,
          used_at: new Date().toISOString(),
        })
        .eq('id', recoveryCode.id)

      return { ok: true, method: 'recovery_code' }
    }
  }

  return { ok: false, method: '' }
}

export async function disableAdminTwoFactor({ admin, req, code }) {
  const now = new Date().toISOString()
  const settings = await getSettings(admin)

  if (settings.authenticator_enabled) {
    const verified = await verifyAdminTwoFactorCode({ admin, code, allowRecovery: true })

    if (!verified.ok) {
      await createAdminSecurityAlert({
        req,
        admin,
        alertType: 'two_factor_disable_failed',
        severity: 'high',
        title: 'Failed 2FA disable attempt',
        message: 'A wrong 2FA code was used while trying to disable 2FA.',
      })

      return {
        ok: false,
        status: 400,
        message: '2FA code is incorrect',
      }
    }
  }

  await supabase
    .from('admin_recovery_codes')
    .delete()
    .eq('admin_email', getAdminIdentity(admin).adminEmail)

  const updated = await updateSettings(admin, {
    authenticator_enabled: false,
    authenticator_secret_encrypted: '',
    email_otp_enabled: false,
    recovery_codes_enabled: false,
    recovery_codes_generated_at: null,
    disabled_at: now,
    last_changed_at: now,
  })

  await insertTwoFactorEvent({
    admin,
    req,
    eventType: 'two_factor_disabled',
    result: 'success',
    reason: '2FA disabled by admin',
  })

  return {
    ok: true,
    status: formatStatus(updated, 0),
  }
}

export async function regenerateAdminRecoveryCodes({ admin, req, code }) {
  const verified = await verifyAdminTwoFactorCode({ admin, code, allowRecovery: false })

  if (!verified.ok) {
    await createAdminSecurityAlert({
      req,
      admin,
      alertType: 'recovery_codes_regenerate_failed',
      severity: 'high',
      title: 'Recovery code regeneration failed',
      message: 'A wrong authenticator code was used while trying to regenerate recovery codes.',
    })

    return {
      ok: false,
      status: 400,
      message: 'Authenticator code is incorrect',
    }
  }

  const now = new Date().toISOString()
  const recoveryCodes = await createRecoveryCodes(admin)
  const updated = await updateSettings(admin, {
    recovery_codes_enabled: true,
    recovery_codes_generated_at: now,
    last_changed_at: now,
  })

  await insertTwoFactorEvent({
    admin,
    req,
    eventType: 'recovery_codes_regenerated',
    result: 'success',
    reason: 'Recovery codes regenerated',
  })

  return {
    ok: true,
    status: formatStatus(updated, recoveryCodes.length),
    recovery_codes: recoveryCodes,
  }
}

export async function listAdminTwoFactorEvents({ admin, limit = 30 }) {
  const { adminId, adminEmail } = getAdminIdentity(admin)
  const safeLimit = Math.min(Math.max(Number(limit || 30), 1), 100)
  let query = supabase
    .from('admin_two_factor_events')
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

async function findAdminForTwoFactorChallenge(challenge) {
  let query = supabase
    .from('admin_users')
    .select('id, email, name, role, password_changed_at')
    .limit(1)

  if (challenge.admin_id) {
    query = query.eq('id', challenge.admin_id)
  } else {
    query = query.eq('email', challenge.admin_email)
  }

  const { data, error } = await query.maybeSingle()

  if (error) throw error

  return data || null
}

export async function shouldRequireAdminTwoFactor({ admin }) {
  const settings = await getSettings(admin)

  return Boolean(settings.authenticator_enabled)
}

export async function createAdminLoginTwoFactorChallenge({ admin, req }) {
  const { adminId, adminEmail } = getAdminIdentity(admin)
  const country = getAdminRequestCountry(req)
  const now = new Date()
  const expiresAt = new Date(now.getTime() + 5 * 60 * 1000).toISOString()

  await supabase
    .from('admin_two_factor_challenges')
    .update({
      status: 'cancelled',
      updated_at: now.toISOString(),
    })
    .eq('admin_email', adminEmail)
    .eq('purpose', 'login')
    .eq('status', 'pending')

  const { data, error } = await supabase
    .from('admin_two_factor_challenges')
    .insert({
      admin_id: adminId,
      admin_email: adminEmail,
      challenge_type: 'authenticator',
      purpose: 'login',
      status: 'pending',
      ip_address: getAdminSecurityClientIp(req),
      user_agent: getUserAgent(req),
      country_code: country.country_code,
      country_name: country.country_name,
      max_attempts: 5,
      expires_at: expiresAt,
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
    })
    .select()
    .single()

  if (error) throw error

  await insertTwoFactorEvent({
    admin,
    req,
    eventType: 'login_two_factor_required',
    result: 'pending',
    reason: 'Password accepted and 2FA required',
  })

  return {
    challenge_id: data.id,
    expires_at: expiresAt,
    methods: ['authenticator', 'recovery_code'],
  }
}

export async function verifyAdminLoginTwoFactorChallenge({ req, challengeId, code }) {
  const cleanChallengeId = cleanText(challengeId, 80)
  const now = new Date().toISOString()

  const { data: challenge, error } = await supabase
    .from('admin_two_factor_challenges')
    .select('*')
    .eq('id', cleanChallengeId)
    .eq('purpose', 'login')
    .eq('status', 'pending')
    .maybeSingle()

  if (error) throw error

  if (!challenge) {
    return {
      ok: false,
      status: 404,
      message: '2FA challenge not found or already used',
    }
  }

  const admin = await findAdminForTwoFactorChallenge(challenge)

  if (!admin) {
    await supabase
      .from('admin_two_factor_challenges')
      .update({
        status: 'failed',
        updated_at: now,
      })
      .eq('id', challenge.id)

    return {
      ok: false,
      status: 404,
      message: 'Admin account not found',
    }
  }

  if (new Date(challenge.expires_at).getTime() <= Date.now()) {
    await supabase
      .from('admin_two_factor_challenges')
      .update({
        status: 'expired',
        updated_at: now,
      })
      .eq('id', challenge.id)

    await createAdminSecurityAlert({
      req,
      admin,
      alertType: 'two_factor_login_expired',
      severity: 'medium',
      title: 'Admin 2FA login challenge expired',
      message: 'An admin 2FA login challenge expired before verification.',
      metadata: {
        challenge_id: challenge.id,
      },
    })

    return {
      ok: false,
      status: 400,
      message: '2FA challenge expired. Please login again.',
    }
  }

  let verified = { ok: false, method: '' }

if (challenge.challenge_type === 'email_otp' && challenge.code_hash) {
  const emailOtpHash = hashCode(admin.email, code)
  if (timingSafeEqualText(challenge.code_hash, emailOtpHash)) {
    verified = { ok: true, method: 'email_otp' }
  }
}

if (!verified.ok) {
  verified = await verifyAdminTwoFactorCode({
    admin,
    code,
    allowRecovery: true,
  })
}
  
  const attemptCount = Number(challenge.attempt_count || 0) + 1

  if (!verified.ok) {
    const failedStatus = attemptCount >= Number(challenge.max_attempts || 5) ? 'failed' : 'pending'

    await supabase
      .from('admin_two_factor_challenges')
      .update({
        attempt_count: attemptCount,
        status: failedStatus,
        updated_at: now,
      })
      .eq('id', challenge.id)

    await createAdminSecurityAlert({
      req,
      admin,
      alertType: failedStatus === 'failed' ? 'two_factor_login_failed_locked' : 'two_factor_login_failed',
      severity: attemptCount >= 3 ? 'high' : 'medium',
      title: failedStatus === 'failed' ? 'Admin 2FA login failed too many times' : 'Admin 2FA login failed',
      message: 'A wrong 2FA code was entered during admin login.',
      metadata: {
        challenge_id: challenge.id,
        attempt_count: attemptCount,
        max_attempts: Number(challenge.max_attempts || 5),
      },
    })

    await insertTwoFactorEvent({
      admin,
      req,
      eventType: failedStatus === 'failed' ? 'login_two_factor_failed_locked' : 'login_two_factor_failed',
      result: 'failed',
      reason: 'Wrong 2FA code during login',
      metadata: {
        challenge_id: challenge.id,
        attempt_count: attemptCount,
      },
    })

    return {
      ok: false,
      status: 400,
      message: failedStatus === 'failed' ? 'Too many wrong 2FA attempts. Please login again.' : '2FA code is incorrect',
      attempts_left: Math.max(0, Number(challenge.max_attempts || 5) - attemptCount),
    }
  }

  await supabase
    .from('admin_two_factor_challenges')
    .update({
      status: 'verified',
      verified_at: now,
      updated_at: now,
    })
    .eq('id', challenge.id)

  await updateSettings(admin, {
    last_verified_at: now,
  })

  await insertTwoFactorEvent({
    admin,
    req,
    eventType: 'login_two_factor_verified',
    result: 'success',
    reason: 'Admin 2FA login verified',
    metadata: {
      challenge_id: challenge.id,
      method: verified.method,
    },
  })

  return {
    ok: true,
    admin,
    method: verified.method,
  }
}

function createEmailOtp() {
  return String(crypto.randomInt(100000, 1000000))
}

async function sendAdminTwoFactorEmail({ to, otp }) {
  const apiKey = String(process.env.RESEND_API_KEY || '').trim()
  const from = String(process.env.ADMIN_RESET_FROM_EMAIL || process.env.RESET_FROM_EMAIL || 'Shadow Admin <onboarding@resend.dev>').trim()

  if (!apiKey) return false

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to,
      subject: 'Your Shadow Admin login code',
      html: `
        <div style="font-family:Arial,sans-serif;line-height:1.6;color:#111827">
          <h2>Shadow Admin email verification code</h2>
          <p>Use this code to continue your admin login.</p>
          <div style="font-size:32px;font-weight:800;letter-spacing:8px;background:#eef2ff;border-radius:14px;padding:18px 22px;display:inline-block">${otp}</div>
          <p>This code expires in 5 minutes.</p>
          <p>If you did not request this, secure your admin account immediately.</p>
        </div>
      `,
      text: `Your Shadow Admin login code is ${otp}. This code expires in 5 minutes.`,
    }),
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(text || 'Failed to send admin email code')
  }

  return true
}

export async function enableAdminEmailOtp({ admin, req, code }) {
  const verified = await verifyAdminTwoFactorCode({ admin, code, allowRecovery: true })

  if (!verified.ok) {
    await createAdminSecurityAlert({
      req,
      admin,
      alertType: 'email_otp_enable_failed',
      severity: 'high',
      title: 'Failed email code enable attempt',
      message: 'A wrong 2FA code was used while trying to enable email code backup.',
    })

    return { ok: false, status: 400, message: '2FA code is incorrect' }
  }

  const updated = await updateSettings(admin, {
    email_otp_enabled: true,
    last_changed_at: new Date().toISOString(),
  })

  await insertTwoFactorEvent({
    admin,
    req,
    eventType: 'email_otp_enabled',
    result: 'success',
    reason: 'Email code backup enabled',
  })

  return {
    ok: true,
    status: formatStatus(updated, await countRecoveryCodes(admin)),
  }
}

export async function disableAdminEmailOtp({ admin, req, code }) {
  const verified = await verifyAdminTwoFactorCode({ admin, code, allowRecovery: true })

  if (!verified.ok) {
    await createAdminSecurityAlert({
      req,
      admin,
      alertType: 'email_otp_disable_failed',
      severity: 'high',
      title: 'Failed email code disable attempt',
      message: 'A wrong 2FA code was used while trying to disable email code backup.',
    })

    return { ok: false, status: 400, message: '2FA code is incorrect' }
  }

  const updated = await updateSettings(admin, {
    email_otp_enabled: false,
    last_changed_at: new Date().toISOString(),
  })

  await insertTwoFactorEvent({
    admin,
    req,
    eventType: 'email_otp_disabled',
    result: 'success',
    reason: 'Email code backup disabled',
  })

  return {
    ok: true,
    status: formatStatus(updated, await countRecoveryCodes(admin)),
  }
}

export async function sendAdminLoginEmailOtp({ req, challengeId }) {
  const cleanChallengeId = cleanText(challengeId, 80)

  if (!isValidUuid(cleanChallengeId)) {
    return { ok: false, status: 400, message: 'Invalid 2FA challenge ID' }
  }

  const { data: challenge, error } = await supabase
    .from('admin_two_factor_challenges')
    .select('*')
    .eq('id', cleanChallengeId)
    .eq('purpose', 'login')
    .eq('status', 'pending')
    .maybeSingle()

  if (error) throw error

  if (!challenge) {
    return { ok: false, status: 404, message: '2FA challenge not found or already used' }
  }

  if (new Date(challenge.expires_at).getTime() <= Date.now()) {
    await supabase
      .from('admin_two_factor_challenges')
      .update({ status: 'expired', updated_at: new Date().toISOString() })
      .eq('id', challenge.id)

    return { ok: false, status: 400, message: '2FA challenge expired. Please login again.' }
  }

  const admin = await findAdminForTwoFactorChallenge(challenge)

  if (!admin) {
    return { ok: false, status: 404, message: 'Admin account not found' }
  }

  const settings = await getSettings(admin)

  if (!settings.email_otp_enabled) {
    return { ok: false, status: 400, message: 'Email code backup is not enabled for this admin account' }
  }

  const otp = createEmailOtp()
  const otpHash = hashCode(admin.email, otp)
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString()
  const emailSent = await sendAdminTwoFactorEmail({ to: admin.email, otp })

  await supabase
    .from('admin_two_factor_challenges')
    .update({
      challenge_type: 'email_otp',
      code_hash: otpHash,
      expires_at: expiresAt,
      updated_at: new Date().toISOString(),
    })
    .eq('id', challenge.id)

  await insertTwoFactorEvent({
    admin,
    req,
    eventType: 'login_email_otp_sent',
    result: emailSent ? 'success' : 'failed',
    reason: emailSent ? 'Email login code sent' : 'Email provider not configured',
    metadata: { challenge_id: challenge.id },
  })

  if (!emailSent) {
    return { ok: false, status: 500, message: 'Email provider is not configured' }
  }

  return {
    ok: true,
    email_sent: true,
    expires_at: expiresAt,
    message: 'Email code sent',
  }
}


