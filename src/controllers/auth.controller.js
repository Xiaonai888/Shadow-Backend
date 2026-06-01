import crypto from 'crypto'
import jwt from 'jsonwebtoken'
import { supabase } from '../config/supabase.js'

const MAX_LOGIN_ATTEMPTS = 5

const LOCK_DURATIONS = [
  1 * 1000,
  1 * 1000,
  1 * 1000,
  1 * 1000,
]

const loginAttempts = new Map()

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase()
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

function getClientKey(req, email) {
  const ip =
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.socket?.remoteAddress ||
    'unknown-ip'

  return `${ip}:${String(email || '').toLowerCase().trim()}`
}

function getLockDuration(lockLevel) {
  const index = Math.min(lockLevel - 1, LOCK_DURATIONS.length - 1)
  return LOCK_DURATIONS[index]
}

function formatRemainingTime(ms) {
  const totalSeconds = Math.ceil(ms / 1000)

  if (totalSeconds < 60) {
    return `${totalSeconds} second${totalSeconds > 1 ? 's' : ''}`
  }

  const totalMinutes = Math.ceil(ms / 60000)

  if (totalMinutes >= 1440) {
    const days = Math.ceil(totalMinutes / 1440)
    return `${days} day${days > 1 ? 's' : ''}`
  }

  if (totalMinutes >= 60) {
    const hours = Math.ceil(totalMinutes / 60)
    return `${hours} hour${hours > 1 ? 's' : ''}`
  }

  return `${totalMinutes} minute${totalMinutes > 1 ? 's' : ''}`
}

function getAttemptState(key) {
  const now = Date.now()

  const current = loginAttempts.get(key) || {
    count: 0,
    lockLevel: 0,
    lockedUntil: 0,
  }

  const remainingMs = Math.max(0, current.lockedUntil - now)

  if (remainingMs > 0) {
    return {
      ...current,
      isLocked: true,
      remainingMs,
    }
  }

  return {
    ...current,
    lockedUntil: 0,
    isLocked: false,
    remainingMs: 0,
  }
}

function recordFailedLogin(key) {
  const now = Date.now()
  const current = getAttemptState(key)

  const nextCount = current.count + 1

  if (nextCount >= MAX_LOGIN_ATTEMPTS) {
    const nextLockLevel = current.lockLevel + 1
    const lockDuration = getLockDuration(nextLockLevel)

    loginAttempts.set(key, {
      count: 0,
      lockLevel: nextLockLevel,
      lockedUntil: now + lockDuration,
    })

    return {
      locked: true,
      remainingMs: lockDuration,
      attemptsLeft: 0,
      lockLevel: nextLockLevel,
    }
  }

  loginAttempts.set(key, {
    count: nextCount,
    lockLevel: current.lockLevel,
    lockedUntil: 0,
  })

  return {
    locked: false,
    remainingMs: 0,
    attemptsLeft: MAX_LOGIN_ATTEMPTS - nextCount,
    lockLevel: current.lockLevel,
  }
}

function clearFailedLogin(key) {
  loginAttempts.delete(key)
}

function createToken(admin) {
  return jwt.sign(
    {
      role: 'admin',
      actor: admin?.name || 'Admin',
      email: admin?.email || '',
      admin_id: admin?.id || '',
    },
    process.env.JWT_SECRET,
    {
      expiresIn: '7d',
    }
  )
}

function createAdminResetOtp() {
  return String(crypto.randomInt(100000, 1000000))
}

function hashAdminResetOtp(email, otp) {
  return crypto
    .createHash('sha256')
    .update(`${normalizeEmail(email)}:${String(otp || '').trim()}`)
    .digest('hex')
}

async function sendAdminPasswordResetEmail({ to, otp }) {
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
      subject: 'Your Shadow Admin password reset code',
      html: `
        <div style="font-family:Arial,sans-serif;line-height:1.6;color:#111827">
          <h2>Admin password reset code</h2>
          <p>Use this 6-digit code to reset your Shadow Admin password.</p>
          <div style="font-size:32px;font-weight:800;letter-spacing:8px;background:#f5f3fa;border-radius:14px;padding:18px 22px;display:inline-block">${otp}</div>
          <p>This code expires in 10 minutes.</p>
          <p>If you did not request this, secure your admin account immediately.</p>
        </div>
      `,
      text: `Your Shadow Admin password reset code is ${otp}. This code expires in 10 minutes.`,
    }),
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(text || 'Failed to send admin reset code')
  }

  return true
}

export async function adminLogin(req, res) {
  try {
    const { email = '', password = '' } = req.body

    if (!process.env.JWT_SECRET) {
      return res.status(500).json({
        ok: false,
        message: 'JWT_SECRET is missing',
      })
    }

    const clientKey = getClientKey(req, email)
    const attemptState = getAttemptState(clientKey)

    if (attemptState.isLocked) {
      return res.status(429).json({
        ok: false,
        message: `Too many failed login attempts. Please try again in ${formatRemainingTime(attemptState.remainingMs)}.`,
        locked: true,
        remainingMs: attemptState.remainingMs,
        lockLevel: attemptState.lockLevel,
      })
    }

    const { data, error } = await supabase.rpc('verify_admin_password', {
      p_email: String(email).trim(),
      p_password: password,
    })

    if (error) throw error

    const admin = Array.isArray(data) ? data[0] : null

    if (!admin) {
      const failed = recordFailedLogin(clientKey)

      if (failed.locked) {
        return res.status(429).json({
          ok: false,
          message: `Too many failed login attempts. Please try again in ${formatRemainingTime(failed.remainingMs)}.`,
          locked: true,
          remainingMs: failed.remainingMs,
          lockLevel: failed.lockLevel,
        })
      }

      return res.status(401).json({
        ok: false,
        message: `Email or password is incorrect. ${failed.attemptsLeft} attempt${failed.attemptsLeft > 1 ? 's' : ''} left before temporary lock.`,
        attemptsLeft: failed.attemptsLeft,
      })
    }

    clearFailedLogin(clientKey)

    const token = createToken(admin)

    return res.status(200).json({
      ok: true,
      token,
      admin: {
        id: admin.id,
        email: admin.email,
        name: admin.name,
        role: admin.role,
        password_changed_at: admin.password_changed_at,
      },
    })
  } catch (error) {
    console.error('ADMIN LOGIN ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Admin login failed',
    })
  }
}

export async function adminForgotPassword(req, res) {
  try {
    const email = normalizeEmail(req.body.email)

    if (!email || !isValidEmail(email)) {
      return res.status(400).json({
        ok: false,
        message: 'Valid admin email is required',
      })
    }

    const { data: admin, error: adminError } = await supabase
      .from('admins')
      .select('id, email')
      .eq('email', email)
      .maybeSingle()

    if (adminError) throw adminError

    if (!admin) {
      return res.status(200).json({
        ok: true,
        message: 'If this admin email exists, a reset code has been sent.',
        email_sent: true,
      })
    }

    await supabase
      .from('admin_password_reset_tokens')
      .update({ used_at: new Date().toISOString() })
      .eq('admin_id', admin.id)
      .is('used_at', null)

    const otp = createAdminResetOtp()
    const otpHash = hashAdminResetOtp(admin.email, otp)
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString()

    const { error: insertError } = await supabase
      .from('admin_password_reset_tokens')
      .insert({
        admin_id: admin.id,
        token_hash: otpHash,
        expires_at: expiresAt,
        attempt_count: 0,
      })

    if (insertError) throw insertError

    const emailSent = await sendAdminPasswordResetEmail({ to: admin.email, otp })

    return res.status(200).json({
      ok: true,
      message: 'If this admin email exists, a reset code has been sent.',
      email_sent: emailSent,
    })
  } catch (error) {
    console.error('ADMIN FORGOT PASSWORD ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to request admin password reset',
    })
  }
}

export async function adminResetPassword(req, res) {
  try {
    const email = normalizeEmail(req.body.email)
    const otp = String(req.body.otp || '').trim()
    const newPassword = String(req.body.newPassword || req.body.password || '')
    const confirmPassword = String(req.body.confirmPassword || '')

    if (!email || !isValidEmail(email)) {
      return res.status(400).json({
        ok: false,
        message: 'Valid admin email is required',
      })
    }

    if (!/^\d{6}$/.test(otp)) {
      return res.status(400).json({
        ok: false,
        message: 'A valid 6-digit code is required',
      })
    }

    if (newPassword.length < 6) {
      return res.status(400).json({
        ok: false,
        message: 'Password must be at least 6 characters',
      })
    }

    if (newPassword !== confirmPassword) {
      return res.status(400).json({
        ok: false,
        message: 'New password and confirm password do not match',
      })
    }

    const { data: admin, error: adminError } = await supabase
      .from('admins')
      .select('id, email')
      .eq('email', email)
      .maybeSingle()

    if (adminError) throw adminError

    if (!admin) {
      return res.status(400).json({
        ok: false,
        message: 'Reset code is invalid or expired',
      })
    }

    const otpHash = hashAdminResetOtp(email, otp)

    const { data: resetRow, error: resetError } = await supabase
      .from('admin_password_reset_tokens')
      .select('id, admin_id, token_hash, expires_at, used_at, attempt_count')
      .eq('admin_id', admin.id)
      .is('used_at', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (resetError) throw resetError

    if (!resetRow || new Date(resetRow.expires_at).getTime() < Date.now()) {
      return res.status(400).json({
        ok: false,
        message: 'Reset code is invalid or expired',
      })
    }

    if (Number(resetRow.attempt_count || 0) >= 5) {
      await supabase
        .from('admin_password_reset_tokens')
        .update({ used_at: new Date().toISOString() })
        .eq('id', resetRow.id)

      return res.status(400).json({
        ok: false,
        message: 'Too many wrong attempts. Please request a new code.',
      })
    }

    if (resetRow.token_hash !== otpHash) {
      await supabase
        .from('admin_password_reset_tokens')
        .update({ attempt_count: Number(resetRow.attempt_count || 0) + 1 })
        .eq('id', resetRow.id)

      return res.status(400).json({
        ok: false,
        message: 'Reset code is incorrect',
      })
    }

    const { data, error } = await supabase.rpc('admin_reset_password', {
      p_email: email,
      p_new_password: newPassword,
    })

    if (error) throw error

    const result = Array.isArray(data) ? data[0] : null

    if (!result?.ok) {
      return res.status(400).json({
        ok: false,
        message: result?.message || 'Failed to reset admin password',
      })
    }

    const updatedAt = new Date().toISOString()

    const { error: updateTokenError } = await supabase
      .from('admin_password_reset_tokens')
      .update({ used_at: updatedAt })
      .eq('id', resetRow.id)

    if (updateTokenError) throw updateTokenError

    return res.status(200).json({
      ok: true,
      message: 'Admin password reset successfully',
    })
  } catch (error) {
    console.error('ADMIN RESET PASSWORD ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to reset admin password',
    })
  }
}

export async function checkAdmin(req, res) {
  return res.status(200).json({
    ok: true,
    admin: req.admin || null,
  })
}

export async function changeAdminPassword(req, res) {
  try {
    const {
      currentPassword = '',
      newPassword = '',
      confirmPassword = '',
    } = req.body

    const email = req.admin?.email

    if (!email) {
      return res.status(401).json({
        ok: false,
        message: 'Admin email missing from token. Please login again.',
      })
    }

    if (!currentPassword || !newPassword || !confirmPassword) {
      return res.status(400).json({
        ok: false,
        message: 'Current password, new password, and confirm password are required',
      })
    }

    if (newPassword !== confirmPassword) {
      return res.status(400).json({
        ok: false,
        message: 'New password and confirm password do not match',
      })
    }

    const { data, error } = await supabase.rpc('change_admin_password', {
      p_email: email,
      p_current_password: currentPassword,
      p_new_password: newPassword,
    })

    if (error) throw error

    const result = Array.isArray(data) ? data[0] : null

    if (!result?.ok) {
      return res.status(400).json({
        ok: false,
        message: result?.message || 'Failed to change admin password',
      })
    }

    return res.status(200).json({
      ok: true,
      message: result.message || 'Admin password changed successfully',
    })
  } catch (error) {
    console.error('CHANGE ADMIN PASSWORD ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to change admin password',
    })
  }
}
