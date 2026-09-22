import express from 'express'
import { supabase } from '../config/supabase.js'
import { requireUser } from '../middleware/user.middleware.js'
import { createRateLimit } from '../middleware/rateLimit.middleware.js'
import {
  getReaderSecuritySettings,
  createReaderEmailChallenge,
  consumeReaderEmailChallenge,
  hashReaderPin,
} from '../services/readerSecurity.service.js'

const router = express.Router()
const REQUEST_PURPOSES = new Set([
  'enable_email_2fa', 'disable_email_2fa', 'setup_pin',
  'change_pin', 'disable_pin', 'reset_pin',
])
const requestLimit = createRateLimit({
  key: 'reader-security-challenge-request',
  windowMs: 600000,
  max: 10,
  identity: (req) => req.user?.user_id,
})
const confirmLimit = createRateLimit({
  key: 'reader-security-challenge-confirm',
  windowMs: 600000,
  max: 12,
  identity: (req) => req.user?.user_id,
})

function allowedPurpose(purpose, settings) {
  if (!REQUEST_PURPOSES.has(purpose)) return false
  if (purpose === 'enable_email_2fa') return !settings.email_2fa_enabled
  if (purpose === 'disable_email_2fa') return settings.email_2fa_enabled
  if (purpose === 'setup_pin') return !settings.pin_hash
  return Boolean(settings.pin_hash)
}

function handleError(error, res) {
  const code = String(error?.code || '')
  if (code === 'READER_EMAIL_CODE_RATE_LIMIT' || code === 'READER_EMAIL_CODE_COOLDOWN') {
    return res.status(429).json({ ok: false, code, message: error.message })
  }
  console.error('READER_SECURITY_SETTINGS_ERROR:', error)
  return res.status(503).json({
    ok: false,
    code: 'READER_SECURITY_UNAVAILABLE',
    message: 'Security settings are temporarily unavailable.',
  })
}

router.use(requireUser)

router.get('/', async (req, res) => {
  try {
    const settings = await getReaderSecuritySettings(req.user.user_id)
    return res.status(200).json({
      ok: true,
      email_2fa_enabled: Boolean(settings.email_2fa_enabled),
      pin_enabled: Boolean(settings.pin_hash),
      pin_locked_until: settings.pin_locked_until || null,
    })
  } catch (error) {
    return handleError(error, res)
  }
})

router.post('/request', requestLimit, async (req, res) => {
  try {
    const userId = req.user.user_id
    const purpose = String(req.body?.purpose || '')
    const settings = await getReaderSecuritySettings(userId)
    if (!allowedPurpose(purpose, settings)) {
      return res.status(400).json({ ok: false, code: 'READER_SECURITY_ACTION_UNAVAILABLE' })
    }
    const { data: user, error: userError } = await supabase.from('users')
      .select('email').eq('id', userId).eq('is_active', true).maybeSingle()
    if (userError) throw userError
    if (!user?.email) return res.status(404).json({ ok: false, code: 'READER_EMAIL_NOT_FOUND' })
    const result = await createReaderEmailChallenge({
      userId,
      email: user.email,
      purpose,
    })
    return res.status(200).json({ ok: true, challenge_id: result.challengeId, expires_at: result.expiresAt })
  } catch (error) {
    return handleError(error, res)
  }
})

router.post('/confirm', confirmLimit, async (req, res) => {
  try {
    const userId = req.user.user_id
    const purpose = String(req.body?.purpose || '')
    const challengeId = String(req.body?.challenge_id || '')
    const code = String(req.body?.code || '')
    const pin = String(req.body?.pin || '')
    const settings = await getReaderSecuritySettings(userId)
    if (!allowedPurpose(purpose, settings)) {
      return res.status(400).json({ ok: false, code: 'READER_SECURITY_ACTION_UNAVAILABLE' })
    }
    if (['setup_pin', 'change_pin', 'reset_pin'].includes(purpose) && !/^\d{6}$/.test(pin)) {
  return res.status(400).json({ ok: false, code: 'READER_PIN_INVALID_FORMAT', message: 'PIN must contain exactly 6 digits.' })
}
    const verified = await consumeReaderEmailChallenge({ userId, challengeId, purpose, code })
    if (!verified.ok) {
      return res.status(400).json({ ok: false, code: verified.code, message: 'Invalid or expired security code.' })
    }
    const updatedAt = new Date().toISOString()
    const update = { user_id: userId, updated_at: updatedAt }
    if (purpose === 'enable_email_2fa') update.email_2fa_enabled = true
    if (purpose === 'disable_email_2fa') update.email_2fa_enabled = false
    if (['setup_pin', 'change_pin', 'reset_pin'].includes(purpose)) {
      update.pin_hash = hashReaderPin(pin)
      update.pin_failed_attempts = 0
      update.pin_locked_until = null
    }
    if (purpose === 'disable_pin') {
      update.pin_hash = null
      update.pin_failed_attempts = 0
      update.pin_locked_until = null
    }
    const { error } = await supabase.from('reader_security_settings')
      .upsert(update, { onConflict: 'user_id' })
    if (error) throw error
    return res.status(200).json({
      ok: true,
      email_2fa_enabled: purpose === 'enable_email_2fa' ? true : purpose === 'disable_email_2fa' ? false : Boolean(settings.email_2fa_enabled),
      pin_enabled: purpose === 'disable_pin' ? false : ['setup_pin', 'change_pin', 'reset_pin'].includes(purpose) ? true : Boolean(settings.pin_hash),
    })
  } catch (error) {
    return handleError(error, res)
  }
})

export default router
