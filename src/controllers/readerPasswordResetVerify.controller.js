import crypto from 'crypto'
import { supabase } from '../config/supabase.js'

export async function verifyPasswordResetCode(req, res) {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase()
    const otp = String(req.body?.otp || '').trim()
    if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !/^\d{6}$/.test(otp)) {
      return res.status(400).json({ ok: false, code: 'INVALID_RESET_OTP', message: 'Reset code is incorrect or expired.' })
    }

    const { data: user, error: userError } = await supabase
      .from('users')
      .select('id, email')
      .eq('email', email)
      .eq('is_active', true)
      .maybeSingle()
    if (userError) throw userError
    if (!user) {
      return res.status(400).json({ ok: false, code: 'INVALID_RESET_OTP', message: 'Reset code is incorrect or expired.' })
    }

    const { data: token, error: tokenError } = await supabase
      .from('password_reset_tokens')
      .select('id, token_hash, expires_at, attempt_count')
      .eq('user_id', user.id)
      .is('used_at', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (tokenError) throw tokenError
    if (!token || !Number.isFinite(new Date(token.expires_at).getTime()) || new Date(token.expires_at).getTime() <= Date.now()) {
      return res.status(400).json({ ok: false, code: 'INVALID_RESET_OTP', message: 'Reset code is incorrect or expired.' })
    }

    const attempts = Number(token.attempt_count || 0)
    if (attempts >= 5) {
      await supabase.from('password_reset_tokens').update({ used_at: new Date().toISOString() }).eq('id', token.id)
      return res.status(400).json({ ok: false, code: 'RESET_OTP_TOO_MANY_ATTEMPTS', message: 'Too many incorrect attempts. Please request a new code.' })
    }

    const expected = crypto.createHash('sha256').update(`${email}:${otp}`).digest()
    const stored = Buffer.from(String(token.token_hash || ''), 'hex')
    const valid = stored.length === expected.length && crypto.timingSafeEqual(stored, expected)
    if (!valid) {
      const nextAttempts = attempts + 1
      const update = { attempt_count: nextAttempts }
      if (nextAttempts >= 5) update.used_at = new Date().toISOString()
      const { error: updateError } = await supabase.from('password_reset_tokens')
        .update(update)
        .eq('id', token.id)
        .eq('attempt_count', attempts)
      if (updateError) throw updateError
      return res.status(400).json({
        ok: false,
        code: nextAttempts >= 5 ? 'RESET_OTP_TOO_MANY_ATTEMPTS' : 'INVALID_RESET_OTP',
        message: nextAttempts >= 5 ? 'Too many incorrect attempts. Please request a new code.' : 'Reset code is incorrect or expired.',
      })
    }

    return res.status(200).json({ ok: true, verified: true })
  } catch (error) {
    console.error('VERIFY PASSWORD RESET CODE ERROR:', error)
    return res.status(503).json({ ok: false, code: 'RESET_OTP_VERIFY_UNAVAILABLE', message: 'Code verification is temporarily unavailable.' })
  }
}
