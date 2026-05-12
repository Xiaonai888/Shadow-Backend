import jwt from 'jsonwebtoken'
import { supabase } from '../config/supabase.js'

const MAX_LOGIN_ATTEMPTS = 5

const LOCK_DURATIONS = [
  15 * 60 * 1000,
  60 * 60 * 1000,
  6 * 60 * 60 * 1000,
  24 * 60 * 60 * 1000,
]

const loginAttempts = new Map()

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
