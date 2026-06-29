import crypto from 'crypto'
import jwt from 'jsonwebtoken'
import { supabase } from '../config/supabase.js'
import {
  checkAdminLoginAllowed,
  recordAdminLoginFailure,
  recordAdminLoginSuccess,
} from '../services/adminGuard.service.js'
import { registerAdminDeviceSession } from '../services/adminDeviceAccess.service.js'
import {
  createAdminLoginTwoFactorChallenge,
  sendAdminLoginEmailOtp,
  shouldRequireAdminTwoFactor,
  verifyAdminLoginTwoFactorChallenge,
} from '../services/adminTwoFactor.service.js'
import {
  shouldRequireAdminPasskeyPin,
  verifyAdminPasskeyPinForLogin,
} from '../services/adminPasskeyPin.service.js'

const PASSKEY_LOGIN_TOKEN_EXPIRES_IN = '5m'
const RESET_REQUEST_COOLDOWN_MS = 60 * 1000
const RESET_REQUEST_15_MIN_MS = 15 * 60 * 1000
const RESET_REQUEST_24_HOUR_MS = 24 * 60 * 60 * 1000
const RESET_REQUEST_15_MIN_LIMIT = 3
const RESET_REQUEST_24_HOUR_LIMIT = 10
const adminResetRequestAttempts = new Map()

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase()
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

function getAdminResetRequestKey(req, email) {
  const ip =
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.socket?.remoteAddress ||
    'unknown-ip'

  return `${ip}:${normalizeEmail(email)}`
}

function checkAdminResetRequestLimit(key) {
  const now = Date.now()
  const current = adminResetRequestAttempts.get(key) || []
  const recent = current.filter((time) => now - time < RESET_REQUEST_24_HOUR_MS)
  const lastRequest = recent[recent.length - 1] || 0
  const requestsIn15Minutes = recent.filter((time) => now - time < RESET_REQUEST_15_MIN_MS).length

  if (lastRequest && now - lastRequest < RESET_REQUEST_COOLDOWN_MS) {
    adminResetRequestAttempts.set(key, recent)
    return false
  }

  if (requestsIn15Minutes >= RESET_REQUEST_15_MIN_LIMIT) {
    adminResetRequestAttempts.set(key, recent)
    return false
  }

  if (recent.length >= RESET_REQUEST_24_HOUR_LIMIT) {
    adminResetRequestAttempts.set(key, recent)
    return false
  }

  adminResetRequestAttempts.set(key, [...recent, now])
  return true
}

function createToken(admin, deviceAccess) {
  return jwt.sign(
    {
      role: admin?.role || 'admin',
      actor: admin?.name || admin?.email || 'Admin',
      email: admin?.email || '',
      admin_id: admin?.id || '',
      password_changed_at: admin?.password_changed_at || '',
      session_id: deviceAccess?.session_id || '',
      device_id: deviceAccess?.device_id || '',
      jwt_id: deviceAccess?.jwt_id || '',
      jti: deviceAccess?.jwt_id || '',
    },
    process.env.JWT_SECRET,
    {
      expiresIn: '7d',
    }
  )
}

function createPasskeyLoginToken({ admin, twoFactorMethod = '' }) {
  return jwt.sign(
    {
      stage: 'admin_passkey_pin_login',
      admin_id: admin?.id || '',
      email: admin?.email || '',
      two_factor_method: twoFactorMethod || '',
    },
    process.env.JWT_SECRET,
    {
      expiresIn: PASSKEY_LOGIN_TOKEN_EXPIRES_IN,
    }
  )
}

function verifyPasskeyLoginToken(token) {
  try {
    const payload = jwt.verify(String(token || ''), process.env.JWT_SECRET)

    if (payload?.stage !== 'admin_passkey_pin_login') return null

    return payload
  } catch {
    return null
  }
}

async function getAdminForPasskeyLoginToken(payload) {
  const adminId = String(payload?.admin_id || '').trim()
  const adminEmail = normalizeEmail(payload?.email)

  if (!adminId && !adminEmail) return null

  let query = supabase
    .from('admin_users')
    .select('id, email, name, role, password_changed_at')
    .limit(1)

  if (adminId) query = query.eq('id', adminId)
  else query = query.eq('email', adminEmail)

  const { data, error } = await query.maybeSingle()

  if (error) throw error
  if (!data) return null
  if (adminEmail && normalizeEmail(data.email) !== adminEmail) return null

  return data
}

function sendPasskeyPinRequired({ res, admin, twoFactorMethod = '' }) {
  const passkeyToken = createPasskeyLoginToken({ admin, twoFactorMethod })

  return res.status(200).json({
    ok: true,
    passkey_pin_required: true,
    passkey_token: passkeyToken,
    passkey_challenge: {
      type: 'jwt',
      token: passkeyToken,
      expires_in_seconds: 300,
    },
    admin: {
      email: admin.email,
      name: admin.name,
    },
    two_factor: {
      verified: Boolean(twoFactorMethod),
      method: twoFactorMethod,
    },
    message: 'Admin Passkey PIN required',
  })
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

async function issueAdminLogin({ req, res, email, admin, twoFactorMethod = '', passkeyPinVerified = false }) {
  const deviceAccess = await registerAdminDeviceSession({
    req,
    res,
    admin,
  })

  if (!deviceAccess.allowed) {
    return res.status(403).json({
      ok: false,
      code: deviceAccess.code || 'ADMIN_DEVICE_ACCESS_DENIED',
      message: deviceAccess.message || 'This admin device is not allowed.',
      active_devices: deviceAccess.active_devices || 0,
      max_devices: deviceAccess.max_devices || 2,
    })
  }

  const adminGuard = await recordAdminLoginSuccess({
    req,
    res,
    email,
    admin,
  })

  const token = createToken(admin, deviceAccess)

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
    two_factor: {
      verified: Boolean(twoFactorMethod),
      method: twoFactorMethod,
    },
    passkey_pin: {
      verified: Boolean(passkeyPinVerified),
    },
    admin_guard: adminGuard,
    admin_device_access: {
      device_id: deviceAccess.device_id,
      session_id: deviceAccess.session_id,
      active_devices: deviceAccess.active_devices,
      max_devices: deviceAccess.max_devices,
      device_label: deviceAccess.device_label,
    },
  })
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

    const guardCheck = await checkAdminLoginAllowed({ req, email })

    if (guardCheck.allowed === false) {
      res.setHeader('Retry-After', String(guardCheck.retry_after_seconds || 60))

      return res.status(429).json({
        ok: false,
        code: guardCheck.code || 'ADMIN_LOGIN_BLOCKED',
        message: guardCheck.message || 'Admin login is temporarily blocked.',
        locked: true,
        block_status: guardCheck.status || 'temporary_block',
        blocked_until: guardCheck.blocked_until || null,
        retry_after_seconds: guardCheck.retry_after_seconds || 60,
      })
    }

    const { data, error } = await supabase.rpc('verify_admin_password', {
      p_email: String(email).trim(),
      p_password: password,
    })

    if (error) throw error

    const admin = Array.isArray(data) ? data[0] : null

    if (!admin) {
      const failed = await recordAdminLoginFailure({
        req,
        email,
        reason: 'Invalid admin email or password',
      })

      if (failed.locked) {
        res.setHeader('Retry-After', String(failed.retry_after_seconds || 60))

        return res.status(429).json({
          ok: false,
          code: failed.code,
          message: failed.message,
          locked: true,
          block_status: failed.block_status,
          blocked_until: failed.blocked_until,
          retry_after_seconds: failed.retry_after_seconds,
          failed_count: failed.failed_count,
        })
      }

      return res.status(401).json({
        ok: false,
        code: 'ADMIN_LOGIN_FAILED',
        message: failed.message || 'Email or password is incorrect.',
        attemptsLeft: failed.attemptsLeft,
        failed_count: failed.failed_count,
      })
    }

    const twoFactorRequired = await shouldRequireAdminTwoFactor({ admin })

    if (twoFactorRequired) {
      const challenge = await createAdminLoginTwoFactorChallenge({
        admin,
        req,
      })

      return res.status(200).json({
        ok: true,
        two_factor_required: true,
        challenge_id: challenge.challenge_id,
        expires_at: challenge.expires_at,
        methods: challenge.methods,
        admin: {
          email: admin.email,
          name: admin.name,
        },
        message: 'Two-factor authentication required',
      })
    }

    const passkeyRequired = await shouldRequireAdminPasskeyPin({ admin })

    if (passkeyRequired) {
      return sendPasskeyPinRequired({
        res,
        admin,
      })
    }

    return issueAdminLogin({
      req,
      res,
      email,
      admin,
    })
  } catch (error) {
    console.error('ADMIN LOGIN ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Admin login failed',
    })
  }
}

export async function adminLoginTwoFactorVerify(req, res) {
  try {
    if (!process.env.JWT_SECRET) {
      return res.status(500).json({
        ok: false,
        message: 'JWT_SECRET is missing',
      })
    }

    const result = await verifyAdminLoginTwoFactorChallenge({
      req,
      challengeId: req.body?.challengeId || req.body?.challenge_id || '',
      code: req.body?.code || '',
    })

    if (!result.ok) {
      return res.status(result.status || 400).json(result)
    }

    const passkeyRequired = await shouldRequireAdminPasskeyPin({ admin: result.admin })

    if (passkeyRequired) {
      return sendPasskeyPinRequired({
        res,
        admin: result.admin,
        twoFactorMethod: result.method,
      })
    }

    return issueAdminLogin({
      req,
      res,
      email: result.admin.email,
      admin: result.admin,
      twoFactorMethod: result.method,
    })
  } catch (error) {
    console.error('ADMIN LOGIN 2FA VERIFY ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Admin 2FA verification failed',
    })
  }
}

export async function adminLoginPasskeyPinVerify(req, res) {
  try {
    if (!process.env.JWT_SECRET) {
      return res.status(500).json({
        ok: false,
        message: 'JWT_SECRET is missing',
      })
    }

    const passkeyToken = req.body?.passkeyToken || req.body?.passkey_token || req.body?.passkey_challenge || ''
    const pin = req.body?.pin || ''
    const payload = verifyPasskeyLoginToken(passkeyToken)

    if (!payload) {
      return res.status(400).json({
        ok: false,
        message: 'Passkey PIN login challenge is invalid or expired',
      })
    }

    const admin = await getAdminForPasskeyLoginToken(payload)

    if (!admin) {
      return res.status(404).json({
        ok: false,
        message: 'Admin account not found',
      })
    }

    const passkeyRequired = await shouldRequireAdminPasskeyPin({ admin })

    if (passkeyRequired) {
      const verified = await verifyAdminPasskeyPinForLogin({
        admin,
        req,
        pin,
      })

      if (!verified.ok) {
        return res.status(verified.status || 400).json(verified)
      }
    }

    return issueAdminLogin({
      req,
      res,
      email: admin.email,
      admin,
      twoFactorMethod: payload.two_factor_method || '',
      passkeyPinVerified: passkeyRequired,
    })
  } catch (error) {
    console.error('ADMIN LOGIN PASSKEY PIN VERIFY ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Admin Passkey PIN verification failed',
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

    const resetRequestKey = getAdminResetRequestKey(req, email)

    if (!checkAdminResetRequestLimit(resetRequestKey)) {
      return res.status(429).json({
        ok: false,
        message: 'Too many reset requests. Please try again later.',
      })
    }

    const { data: admin, error: adminError } = await supabase
      .from('admin_users')
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
      .from('admin_users')
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
  try {
    const adminId = req.admin?.admin_id || ''
    const adminEmail = req.admin?.email || ''

    let query = supabase
      .from('admin_users')
      .select('id, email, name, role, password_changed_at')
      .limit(1)

    if (adminId) {
      query = query.eq('id', adminId)
    } else if (adminEmail) {
      query = query.eq('email', adminEmail)
    } else {
      return res.status(401).json({
        ok: false,
        message: 'Admin identity missing from token',
      })
    }

    const { data, error } = await query.maybeSingle()

    if (error) throw error

    if (!data) {
      return res.status(404).json({
        ok: false,
        message: 'Admin account not found',
      })
    }

    return res.status(200).json({
      ok: true,
      admin: {
        id: data.id,
        email: data.email,
        name: data.name,
        role: data.role,
        password_changed_at: data.password_changed_at,
      },
    })
  } catch (error) {
    console.error('CHECK ADMIN ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load admin profile',
    })
  }
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

export async function adminLoginTwoFactorEmailSend(req, res) {
  try {
    const result = await sendAdminLoginEmailOtp({
      req,
      challengeId: req.body?.challengeId || req.body?.challenge_id || '',
    })

    if (!result.ok) {
      return res.status(result.status || 400).json(result)
    }

    return res.status(200).json(result)
  } catch (error) {
    console.error('ADMIN LOGIN 2FA EMAIL SEND ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to send admin email code',
    })
  }
}
