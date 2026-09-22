import crypto from 'node:crypto'
import { supabase } from '../config/supabase.js'

const EMAIL_CODE_MINUTES = 10
const EMAIL_MAX_ATTEMPTS = 5
const PIN_MAX_ATTEMPTS = 5
const PIN_LOCK_MINUTES = 15
const CHALLENGE_PURPOSES = new Set(['login', 'enable_email_2fa', 'disable_email_2fa', 'setup_pin', 'change_pin', 'disable_pin', 'reset_pin'])

function securitySecret() {
  const secret = process.env.READER_SECURITY_SECRET || process.env.JWT_SECRET
  if (!secret || secret.length < 32) throw new Error('Reader security secret is not configured')
  return secret
}

function hashCode(userId, challengeId, code) {
  return crypto.createHmac('sha256', securitySecret())
    .update(`${userId}:${challengeId}:${code}`).digest('hex')
}

function safeEqualHex(left, right) {
  if (!/^[a-f0-9]{64}$/i.test(String(left)) || !/^[a-f0-9]{64}$/i.test(String(right))) return false
  return crypto.timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'))
}

function assertPurpose(purpose) {
  if (!CHALLENGE_PURPOSES.has(purpose)) throw new Error('Invalid reader security challenge purpose')
}

export async function getReaderSecuritySettings(userId) {
  const { data, error } = await supabase.from('reader_security_settings')
    .select('user_id,email_2fa_enabled,pin_hash,pin_failed_attempts,pin_locked_until')
    .eq('user_id', userId).maybeSingle()
  if (error) throw error
  return data || {
    user_id: userId,
    email_2fa_enabled: false,
    pin_hash: null,
    pin_failed_attempts: 0,
    pin_locked_until: null,
  }
}

export async function createReaderEmailChallenge({ userId, email, purpose, deviceKey = '' }) {
  assertPurpose(purpose)
  const to = String(email || '').trim().toLowerCase()
  const apiKey = String(process.env.RESEND_API_KEY || '').trim()
  if (!apiKey) throw new Error('Reader security email service is unavailable')
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) throw new Error('Invalid reader security email')

  const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString()
  const { count, error: countError } = await supabase.from('reader_security_challenges')
    .select('id', { count: 'exact', head: true }).eq('user_id', userId)
    .eq('purpose', purpose).gte('created_at', hourAgo)
  if (countError) throw countError
  if (Number(count || 0) >= 5) {
    const error = new Error('Too many email codes. Please try again later.')
    error.code = 'READER_EMAIL_CODE_RATE_LIMIT'
    throw error
  }

  const { data: recent, error: recentError } = await supabase.from('reader_security_challenges')
    .select('created_at').eq('user_id', userId).eq('purpose', purpose)
    .order('created_at', { ascending: false }).limit(1).maybeSingle()
  if (recentError) throw recentError
  if (recent && Date.now() - new Date(recent.created_at).getTime() < 60000) {
    const error = new Error('Please wait 60 seconds before requesting another code.')
    error.code = 'READER_EMAIL_CODE_COOLDOWN'
    throw error
  }

  const challengeId = crypto.randomUUID()
  const code = String(crypto.randomInt(100000, 1000000))
  const expiry = new Date(Date.now() + EMAIL_CODE_MINUTES * 60000).toISOString()
  const deviceKeyHash = deviceKey
    ? crypto.createHash('sha256').update(deviceKey).digest('hex')
    : null
  const { error: insertError } = await supabase.from('reader_security_challenges').insert({
    id: challengeId,
    user_id: userId,
    purpose,
    email_code_hash: hashCode(userId, challengeId, code),
    email_code_expires_at: expiry,
    email_attempts: 0,
    device_key_hash: deviceKeyHash,
    last_email_sent_at: new Date().toISOString(),
    email_send_count: 1,
    expires_at: expiry,
  })
  if (insertError) throw insertError

  const from = String(process.env.EMAIL_FROM || process.env.RESET_FROM_EMAIL || 'Shadow Era Book <onboarding@resend.dev>').trim()
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from,
        to,
        subject: 'Your Shadow login security code',
        text: `Your Shadow security code is ${code}. It expires in ${EMAIL_CODE_MINUTES} minutes. If you did not request this, ignore this email.`,
      }),
    })
    if (!response.ok) throw new Error('Failed to send reader security email')
  } catch (error) {
    await supabase.from('reader_security_challenges')
      .update({ consumed_at: new Date().toISOString() }).eq('id', challengeId)
    throw error
  }
  return { challengeId, expiresAt: expiry }
}

export async function consumeReaderEmailChallenge({ userId, challengeId, purpose, code, deviceKey = '' }) {
  assertPurpose(purpose)
  if (!/^[0-9a-f-]{36}$/i.test(String(challengeId || '')) || !/^\d{6}$/.test(String(code || ''))) {
    return { ok: false, code: 'READER_SECURITY_CODE_INVALID' }
  }
  const { data: challenge, error } = await supabase.from('reader_security_challenges')
    .select('id,email_code_hash,email_code_expires_at,email_attempts,device_key_hash,expires_at')
    .eq('id', challengeId).eq('user_id', userId).eq('purpose', purpose)
    .is('consumed_at', null).maybeSingle()
  if (error) throw error
  if (!challenge || new Date(challenge.expires_at).getTime() <= Date.now() ||
    new Date(challenge.email_code_expires_at).getTime() <= Date.now() ||
    Number(challenge.email_attempts) >= EMAIL_MAX_ATTEMPTS) {
    return { ok: false, code: 'READER_SECURITY_CODE_EXPIRED' }
  }
  const keyHash = deviceKey
    ? crypto.createHash('sha256').update(deviceKey).digest('hex')
    : null
  if (challenge.device_key_hash && !safeEqualHex(challenge.device_key_hash, keyHash)) {
    return { ok: false, code: 'READER_SECURITY_DEVICE_MISMATCH' }
  }
  if (!safeEqualHex(challenge.email_code_hash, hashCode(userId, challengeId, code))) {
    const attempts = Number(challenge.email_attempts) + 1
    const { error: attemptError } = await supabase.from('reader_security_challenges')
      .update({
        email_attempts: attempts,
        ...(attempts >= EMAIL_MAX_ATTEMPTS ? { consumed_at: new Date().toISOString() } : {}),
      }).eq('id', challengeId).eq('email_attempts', challenge.email_attempts)
      .is('consumed_at', null)
    if (attemptError) throw attemptError
    return { ok: false, code: 'READER_SECURITY_CODE_INVALID' }
  }
  const { data: consumed, error: consumeError } = await supabase.from('reader_security_challenges')
    .update({ consumed_at: new Date().toISOString(), email_verified_at: new Date().toISOString() })
    .eq('id', challengeId).eq('email_attempts', challenge.email_attempts)
    .is('consumed_at', null).gt('expires_at', new Date().toISOString())
    .select('id').maybeSingle()
  if (consumeError) throw consumeError
  return consumed ? { ok: true } : { ok: false, code: 'READER_SECURITY_CODE_EXPIRED' }
}

export function hashReaderPin(pin) {
  if (!/^\d{6}$/.test(String(pin || ''))) throw new Error('PIN must contain exactly 6 digits')
  const salt = crypto.randomBytes(16).toString('hex')
  const derived = crypto.scryptSync(pin, salt, 64).toString('hex')
  return `${salt}:${derived}`
}

export function verifyReaderPin(pin, storedHash) {
  if (!/^(?:\d{4}|\d{6})$/.test(String(pin || ''))) return false
  const [salt, digest] = String(storedHash || '').split(':')
  if (!/^[0-9a-f]{32}$/.test(salt || '') || !/^[0-9a-f]{128}$/.test(digest || '')) return false
  const candidate = crypto.scryptSync(pin, salt, 64)
  return crypto.timingSafeEqual(candidate, Buffer.from(digest, 'hex'))
}

export async function verifyReaderPinForUser(userId, pin) {
  const settings = await getReaderSecuritySettings(userId)
  if (!settings.pin_hash) return { ok: false, code: 'READER_PIN_NOT_SET' }
  if (settings.pin_locked_until && new Date(settings.pin_locked_until).getTime() > Date.now()) {
    return { ok: false, code: 'READER_PIN_LOCKED', lockedUntil: settings.pin_locked_until }
  }
  if (verifyReaderPin(pin, settings.pin_hash)) {
    const { error } = await supabase.from('reader_security_settings')
      .update({ pin_failed_attempts: 0, pin_locked_until: null, updated_at: new Date().toISOString() })
      .eq('user_id', userId)
    if (error) throw error
    return { ok: true }
  }
  const attempts = Number(settings.pin_failed_attempts || 0) + 1
  const lockedUntil = attempts >= PIN_MAX_ATTEMPTS
    ? new Date(Date.now() + PIN_LOCK_MINUTES * 60000).toISOString()
    : null
  const { error } = await supabase.from('reader_security_settings')
    .update({ pin_failed_attempts: attempts, pin_locked_until: lockedUntil, updated_at: new Date().toISOString() })
    .eq('user_id', userId)
  if (error) throw error
  return { ok: false, code: lockedUntil ? 'READER_PIN_LOCKED' : 'READER_PIN_INVALID', lockedUntil }
}
