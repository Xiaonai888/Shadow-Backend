import crypto from 'crypto'
import jwt from 'jsonwebtoken'
import { supabase } from '../config/supabase.js'

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase()
}

function normalizeUsername(username) {
  return String(username || '')
    .trim()
    .replace(/^@+/, '')
    .toLowerCase()
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

function isGmailEmail(email) {
  return /^[^\s@]+@gmail\.com$/.test(email)
}

function calculateAge(dateOfBirth) {
  const birthDate = new Date(dateOfBirth)
  const today = new Date()

  if (Number.isNaN(birthDate.getTime())) return null

  let age = today.getFullYear() - birthDate.getFullYear()
  const monthDiff = today.getMonth() - birthDate.getMonth()

  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthDate.getDate())) {
    age -= 1
  }

  return age
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex')
  const hash = crypto.scryptSync(password, salt, 64).toString('hex')

  return `${salt}:${hash}`
}

function verifyPassword(password, passwordHash) {
  const [salt, storedHash] = String(passwordHash || '').split(':')

  if (!salt || !storedHash) return false

  const hashBuffer = crypto.scryptSync(password, salt, 64)
  const storedBuffer = Buffer.from(storedHash, 'hex')

  if (hashBuffer.length !== storedBuffer.length) return false

  return crypto.timingSafeEqual(hashBuffer, storedBuffer)
}

function hashResetToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex')
}

function createResetToken() {
  return crypto.randomBytes(32).toString('hex')
}

function getReaderAppUrl() {
  return String(process.env.READER_APP_URL || 'https://shadowerabook.site').replace(/\/$/, '')
}

async function sendPasswordResetEmail({ to, resetUrl }) {
  const apiKey = String(process.env.RESEND_API_KEY || '').trim()
  const from = String(process.env.RESET_FROM_EMAIL || 'Shadow Era Book <onboarding@resend.dev>').trim()

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
      subject: 'Reset your Shadow Era Book password',
      html: `<p>You requested to reset your password.</p><p><a href="${resetUrl}">Reset Password</a></p><p>This link expires in 30 minutes.</p>`,
    }),
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(text || 'Failed to send reset email')
  }

  return true
}

function createUserToken(user) {
  return jwt.sign(
    {
      type: 'reader',
      user_id: user.id,
      email: user.email,
      username: user.username,
      role: user.role,
      is_author: Boolean(user.is_author),
    },
    process.env.JWT_SECRET,
    {
      expiresIn: '30d',
    }
  )
}

function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    username: user.username,
    email: user.email,
    avatar_url: user.avatar_url || null,
    bio: user.bio || '',
    work: user.work || '',
    location: user.location || '',
    date_of_birth: user.date_of_birth,
    gender: user.gender,
    custom_gender: user.custom_gender,
    role: user.role,
    is_author: Boolean(user.is_author),
    is_active: Boolean(user.is_active),
    is_email_verified: Boolean(user.is_email_verified),
    created_at: user.created_at,
    updated_at: user.updated_at,
  }
}

export async function registerUser(req, res) {
  try {
    if (!process.env.JWT_SECRET) {
      return res.status(500).json({
        ok: false,
        message: 'JWT_SECRET is missing',
      })
    }

    const name = String(req.body.name || '').trim()
    const username = normalizeUsername(req.body.username)
    const email = normalizeEmail(req.body.email)
    const password = String(req.body.password || '')
    const confirmPassword = String(req.body.confirmPassword || '')
    const dateOfBirth = String(req.body.date_of_birth || req.body.dateOfBirth || '').trim()
    const gender = String(req.body.gender || '').trim()
    const customGender = String(req.body.custom_gender || req.body.customGender || '').trim() || null

    if (!name || !username || !email || !password || !confirmPassword || !dateOfBirth || !gender) {
      return res.status(400).json({
        ok: false,
        message: 'Please fill in all required fields',
      })
    }

    if (!isValidEmail(email)) {
      return res.status(400).json({
        ok: false,
        message: 'Email is not valid',
      })
    }

    if (!isGmailEmail(email)) {
      return res.status(400).json({
        ok: false,
        message: 'Only Gmail accounts are allowed',
      })
    }

    if (username.length < 3) {
      return res.status(400).json({
        ok: false,
        message: 'Username must be at least 3 characters',
      })
    }

    if (!/^[a-z0-9_]+$/.test(username)) {
      return res.status(400).json({
        ok: false,
        message: 'Username can only use letters, numbers, and underscore',
      })
    }

    if (password.length < 6) {
      return res.status(400).json({
        ok: false,
        message: 'Password must be at least 6 characters',
      })
    }

    if (password !== confirmPassword) {
      return res.status(400).json({
        ok: false,
        message: 'Password and confirm password do not match',
      })
    }

    if (!['female', 'male', 'custom'].includes(gender)) {
      return res.status(400).json({
        ok: false,
        message: 'Gender is not valid',
      })
    }

    if (gender === 'custom' && !customGender) {
      return res.status(400).json({
        ok: false,
        message: 'Please select custom gender',
      })
    }

    const age = calculateAge(dateOfBirth)

    if (age === null || age < 0) {
      return res.status(400).json({
        ok: false,
        message: 'Date of birth is not valid',
      })
    }

    const { data: existingUser, error: existingError } = await supabase
      .from('users')
      .select('id, email, username')
      .or(`email.eq.${email},username.eq.${username}`)
      .maybeSingle()

    if (existingError) throw existingError

    if (existingUser) {
      const message =
        existingUser.email === email
          ? 'Email already exists'
          : 'Username already exists'

      return res.status(409).json({
        ok: false,
        message,
      })
    }

    const passwordHash = hashPassword(password)

    const { data, error } = await supabase
      .from('users')
      .insert({
        name,
        username,
        email,
        password_hash: passwordHash,
        date_of_birth: dateOfBirth,
        gender,
        custom_gender: gender === 'custom' ? customGender : null,
        avatar_url: null,
        bio: '',
        work: '',
        location: '',
        role: 'reader',
        is_author: false,
        is_active: true,
        is_email_verified: false,
        updated_at: new Date().toISOString(),
      })
      .select()
      .single()

    if (error) throw error

    const token = createUserToken(data)

    return res.status(201).json({
      ok: true,
      token,
      user: publicUser(data),
    })
  } catch (error) {
    console.error('REGISTER USER ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to create account',
      error: error.message,
    })
  }
}

export async function loginUser(req, res) {
  try {
    if (!process.env.JWT_SECRET) {
      return res.status(500).json({
        ok: false,
        message: 'JWT_SECRET is missing',
      })
    }

    const email = normalizeEmail(req.body.email)
    const password = String(req.body.password || '')

    if (!email || !password) {
      return res.status(400).json({
        ok: false,
        message: 'Email and password are required',
      })
    }

    const { data, error } = await supabase
      .from('users')
      .select('*')
      .eq('email', email)
      .eq('is_active', true)
      .maybeSingle()

    if (error) throw error

    if (!data || !verifyPassword(password, data.password_hash)) {
      return res.status(401).json({
        ok: false,
        message: 'Email or password is incorrect',
      })
    }

    const token = createUserToken(data)

    return res.status(200).json({
      ok: true,
      token,
      user: publicUser(data),
    })
  } catch (error) {
    console.error('LOGIN USER ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Login failed',
      error: error.message,
    })
  }
}

export async function requestPasswordReset(req, res) {
  try {
    const email = normalizeEmail(req.body.email)

    if (!email || !isValidEmail(email)) {
      return res.status(400).json({
        ok: false,
        message: 'Valid email is required',
      })
    }

    const { data: user, error: userError } = await supabase
      .from('users')
      .select('id, email, is_active')
      .eq('email', email)
      .eq('is_active', true)
      .maybeSingle()

    if (userError) throw userError

    if (!user) {
      return res.status(200).json({
        ok: true,
        message: 'If this email exists, a reset link has been sent.',
      })
    }

    await supabase
      .from('password_reset_tokens')
      .update({ used_at: new Date().toISOString() })
      .eq('user_id', user.id)
      .is('used_at', null)

    const token = createResetToken()
    const tokenHash = hashResetToken(token)
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString()

    const { error: insertError } = await supabase
      .from('password_reset_tokens')
      .insert({
        user_id: user.id,
        token_hash: tokenHash,
        expires_at: expiresAt,
      })

    if (insertError) throw insertError

    const resetUrl = `${getReaderAppUrl()}/reset-password?token=${token}`
    const emailSent = await sendPasswordResetEmail({ to: user.email, resetUrl })

    return res.status(200).json({
      ok: true,
      message: 'If this email exists, a reset link has been sent.',
      email_sent: emailSent,
      reset_url: emailSent ? undefined : resetUrl,
    })
  } catch (error) {
    console.error('REQUEST PASSWORD RESET ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to request password reset',
      error: error.message,
    })
  }
}

export async function resetPassword(req, res) {
  try {
    const token = String(req.body.token || '').trim()
    const password = String(req.body.password || '')
    const confirmPassword = String(req.body.confirmPassword || '')

    if (!token) {
      return res.status(400).json({
        ok: false,
        message: 'Reset token is required',
      })
    }

    if (password.length < 6) {
      return res.status(400).json({
        ok: false,
        message: 'Password must be at least 6 characters',
      })
    }

    if (password !== confirmPassword) {
      return res.status(400).json({
        ok: false,
        message: 'Password and confirm password do not match',
      })
    }

    const tokenHash = hashResetToken(token)

    const { data: resetRow, error: resetError } = await supabase
      .from('password_reset_tokens')
      .select('id, user_id, expires_at, used_at')
      .eq('token_hash', tokenHash)
      .is('used_at', null)
      .maybeSingle()

    if (resetError) throw resetError

    if (!resetRow || new Date(resetRow.expires_at).getTime() < Date.now()) {
      return res.status(400).json({
        ok: false,
        message: 'Reset link is invalid or expired',
      })
    }

    const passwordHash = hashPassword(password)
    const updatedAt = new Date().toISOString()

    const { data: user, error: updateUserError } = await supabase
      .from('users')
      .update({
        password_hash: passwordHash,
        updated_at: updatedAt,
      })
      .eq('id', resetRow.user_id)
      .eq('is_active', true)
      .select()
      .single()

    if (updateUserError) throw updateUserError

    const { error: updateTokenError } = await supabase
      .from('password_reset_tokens')
      .update({ used_at: updatedAt })
      .eq('id', resetRow.id)

    if (updateTokenError) throw updateTokenError

    const authToken = createUserToken(user)

    return res.status(200).json({
      ok: true,
      message: 'Password reset successfully',
      token: authToken,
      user: publicUser(user),
    })
  } catch (error) {
    console.error('RESET PASSWORD ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to reset password',
      error: error.message,
    })
  }
}

export async function getCurrentUser(req, res) {
  try {
    const userId = req.user?.user_id

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    const { data, error } = await supabase
      .from('users')
      .select('*')
      .eq('id', userId)
      .eq('is_active', true)
      .maybeSingle()

    if (error) throw error

    if (!data) {
      return res.status(404).json({
        ok: false,
        message: 'User not found',
      })
    }

    return res.status(200).json({
      ok: true,
      user: publicUser(data),
    })
  } catch (error) {
    console.error('GET CURRENT USER ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to fetch user',
      error: error.message,
    })
  }
}

export async function updateUserAvatar(req, res) {
  try {
    const userId = req.user?.user_id

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    const avatarUrl = String(req.body.avatar_url || req.body.avatarUrl || '').trim()

    if (!avatarUrl) {
      return res.status(400).json({
        ok: false,
        message: 'Avatar URL is required',
      })
    }

    const { data, error } = await supabase
      .from('users')
      .update({
        avatar_url: avatarUrl,
        updated_at: new Date().toISOString(),
      })
      .eq('id', userId)
      .eq('is_active', true)
      .select()
      .single()

    if (error) throw error

    return res.status(200).json({
      ok: true,
      message: 'Profile photo updated',
      user: publicUser(data),
    })
  } catch (error) {
    console.error('UPDATE USER AVATAR ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to update profile photo',
      error: error.message,
    })
  }
}

export async function updateUserProfile(req, res) {
  try {
    const userId = req.user?.user_id

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    const name = String(req.body.name || '').trim()
    const bio = String(req.body.bio || '').trim()
    const work = String(req.body.work || '').trim()
    const location = String(req.body.location || '').trim()

    if (!name) {
      return res.status(400).json({
        ok: false,
        message: 'Display name is required',
      })
    }

    if (name.length < 2) {
      return res.status(400).json({
        ok: false,
        message: 'Display name must be at least 2 characters',
      })
    }

    if (bio.length > 180) {
      return res.status(400).json({
        ok: false,
        message: 'Bio must be 180 characters or less',
      })
    }

    if (work.length > 80 || location.length > 80) {
      return res.status(400).json({
        ok: false,
        message: 'Work and location must be 80 characters or less',
      })
    }

    const { data, error } = await supabase
      .from('users')
      .update({
        name,
        bio,
        work,
        location,
        updated_at: new Date().toISOString(),
      })
      .eq('id', userId)
      .eq('is_active', true)
      .select()
      .single()

    if (error) throw error

    return res.status(200).json({
      ok: true,
      message: 'Profile updated',
      user: publicUser(data),
    })
  } catch (error) {
    console.error('UPDATE USER PROFILE ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to update profile',
      error: error.message,
    })
  }
}
