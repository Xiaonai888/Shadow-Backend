import jwt from 'jsonwebtoken'

const MAX_LOGIN_ATTEMPTS = 5
const LOCK_TIME_MS = 15 * 60 * 1000 // 15 minutes

// Simple in-memory lock system.
// Good for basic protection on Render single service.
// If the server restarts, this lock resets.
const loginAttempts = new Map()

function getClientKey(req, email) {
  const ip =
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.socket?.remoteAddress ||
    'unknown-ip'

  return `${ip}:${String(email || '').toLowerCase().trim()}`
}

function getAttemptState(key) {
  const now = Date.now()
  const current = loginAttempts.get(key)

  if (!current) {
    return {
      count: 0,
      lockedUntil: 0,
      isLocked: false,
      remainingMs: 0,
    }
  }

  const remainingMs = Math.max(0, current.lockedUntil - now)

  if (remainingMs > 0) {
    return {
      ...current,
      isLocked: true,
      remainingMs,
    }
  }

  if (current.lockedUntil && current.lockedUntil <= now) {
    loginAttempts.delete(key)
    return {
      count: 0,
      lockedUntil: 0,
      isLocked: false,
      remainingMs: 0,
    }
  }

  return {
    ...current,
    isLocked: false,
    remainingMs: 0,
  }
}

function recordFailedLogin(key) {
  const now = Date.now()
  const current = loginAttempts.get(key) || {
    count: 0,
    lockedUntil: 0,
  }

  const nextCount = current.count + 1

  if (nextCount >= MAX_LOGIN_ATTEMPTS) {
    loginAttempts.set(key, {
      count: nextCount,
      lockedUntil: now + LOCK_TIME_MS,
    })

    return {
      locked: true,
      remainingMs: LOCK_TIME_MS,
      attemptsLeft: 0,
    }
  }

  loginAttempts.set(key, {
    count: nextCount,
    lockedUntil: 0,
  })

  return {
    locked: false,
    remainingMs: 0,
    attemptsLeft: MAX_LOGIN_ATTEMPTS - nextCount,
  }
}

function clearFailedLogin(key) {
  loginAttempts.delete(key)
}

function formatRemainingTime(ms) {
  const minutes = Math.ceil(ms / 60000)
  return `${minutes} minute${minutes > 1 ? 's' : ''}`
}

function createToken() {
  return jwt.sign(
    {
      role: 'admin',
      actor: 'Admin',
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

    if (!process.env.ADMIN_EMAIL || !process.env.ADMIN_PASSWORD || !process.env.JWT_SECRET) {
      return res.status(500).json({
        ok: false,
        message: 'Admin auth environment variables are missing',
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
      })
    }

    const cleanEmail = String(email).trim()
    const emailOk = cleanEmail === process.env.ADMIN_EMAIL
    const passwordOk = password === process.env.ADMIN_PASSWORD

    if (!emailOk || !passwordOk) {
      const failed = recordFailedLogin(clientKey)

      if (failed.locked) {
        return res.status(429).json({
          ok: false,
          message: `Too many failed login attempts. Please try again in ${formatRemainingTime(failed.remainingMs)}.`,
          locked: true,
          remainingMs: failed.remainingMs,
        })
      }

      return res.status(401).json({
        ok: false,
        message: `Email or password is incorrect. ${failed.attemptsLeft} attempt${failed.attemptsLeft > 1 ? 's' : ''} left before temporary lock.`,
        attemptsLeft: failed.attemptsLeft,
      })
    }

    clearFailedLogin(clientKey)

    const token = createToken()

    res.status(200).json({
      ok: true,
      token,
      admin: {
        email: process.env.ADMIN_EMAIL,
        name: 'Admin',
      },
    })
  } catch (error) {
    console.error('ADMIN LOGIN ERROR:', error)

    res.status(500).json({
      ok: false,
      message: 'Admin login failed',
    })
  }
}

export async function checkAdmin(req, res) {
  res.status(200).json({
    ok: true,
    admin: req.admin || null,
  })
}
