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
}

function escapeLikePattern(value) {
  return String(value || '').replace(/[\\%_]/g, '\\$&')
}

const PROFILE_LINK_TYPES = ['website', 'facebook', 'instagram', 'telegram', 'tiktok', 'youtube', 'x', 'link']

function normalizeProfileLinks(value) {
  const links = Array.isArray(value) ? value : []
  return links.slice(0, 5).map((item) => ({ type: String(item?.type || 'link').trim().toLowerCase(), url: String(item?.url || '').trim() })).filter((item) => PROFILE_LINK_TYPES.includes(item.type) && /^https?:\/\/\S+$/i.test(item.url))
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

function isAllowedEmail(email) {
  const domain = String(email).split('@').pop()
  return ['gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'icloud.com'].includes(domain)
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

function hashResetOtp(email, otp) {
  return crypto
    .createHash('sha256')
    .update(`${normalizeEmail(email)}:${String(otp || '').trim()}`)
    .digest('hex')
}

function createResetOtp() {
  return String(crypto.randomInt(100000, 1000000))
}

async function sendPasswordResetOtpEmail({ to, otp }) {
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
      subject: 'Your Shadow Era Book password reset code',
      html: `
        <div style="font-family:Arial,sans-serif;line-height:1.6;color:#111827">
          <h2>Password reset code</h2>
          <p>Use this 6-digit code to reset your Shadow Era Book password.</p>
          <div style="font-size:32px;font-weight:800;letter-spacing:8px;background:#f5f3fa;border-radius:14px;padding:18px 22px;display:inline-block">${otp}</div>
          <p>This code expires in 10 minutes.</p>
          <p>If you did not request this, you can ignore this email.</p>
        </div>
      `,
      text: `Your Shadow Era Book password reset code is ${otp}. This code expires in 10 minutes.`,
    }),
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(text || 'Failed to send reset code')
  }

  return true
}

const EMAIL_CHANGE_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000

function hashEmailChangeOtp(userId, email, otp) {
  return crypto
    .createHash('sha256')
    .update(
      `${String(userId || '')}:${normalizeEmail(email)}:${String(otp || '').trim()}`
    )
    .digest('hex')
}

async function sendEmailChangeOtpEmail({ to, otp }) {
  const apiKey = String(process.env.RESEND_API_KEY || '').trim()
  const from = String(
    process.env.EMAIL_FROM ||
      process.env.RESET_FROM_EMAIL ||
      'Shadow Era Book <onboarding@resend.dev>'
  ).trim()

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
      subject: 'Verify your new Shadow Era Book email',
      html: `
        <div style="font-family:Arial,sans-serif;line-height:1.6;color:#111827">
          <h2>Verify your new email</h2>
          <p>Use this 6-digit code to confirm your new Shadow Era Book email address.</p>
          <div style="font-size:32px;font-weight:800;letter-spacing:8px;background:#f5f3fa;border-radius:14px;padding:18px 22px;display:inline-block">${otp}</div>
          <p>This code expires in 10 minutes.</p>
          <p>If you did not request this change, you can ignore this email.</p>
        </div>
      `,
      text: `Your Shadow Era Book email verification code is ${otp}. This code expires in 10 minutes.`,
    }),
  })

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(body || 'Failed to send email verification code')
  }

  return true
}

function createUserToken(user) {
  return jwt.sign(
    {
      type: 'reader',
      user_id: user.id,
      email: user.email,
      payment_account_name: user.payment_account_name || '',
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
    email_changed_at: user.email_changed_at || null,
    avatar_url: user.avatar_url || null,
    bio: user.bio || '',
    work: user.work || '',
    location: user.location || '',
    social_links: Array.isArray(user.social_links) ? user.social_links : [],
    date_of_birth: user.date_of_birth,
    date_of_birth_updated_at: user.date_of_birth_updated_at || null,
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

function publicUserProfile(user, counts = {}, isFollowing = false) {
  const {
    email,
    email_changed_at,
    date_of_birth,
    date_of_birth_updated_at,
    ...profile
  } = publicUser(user)
  return {
    ...profile,
    followers_count: Number(counts.followers_count || 0),
    following_count: Number(counts.following_count || 0),
    is_following: Boolean(isFollowing),
  }
}

async function getUserFollowCounts(userId) {
  const [{ count: followersCount, error: followersError }, { count: followingCount, error: followingError }] = await Promise.all([
    supabase
      .from('user_follows')
      .select('id', { count: 'exact', head: true })
      .eq('following_user_id', userId),
    supabase
      .from('user_follows')
      .select('id', { count: 'exact', head: true })
      .eq('follower_user_id', userId),
  ])

  if (followersError) throw followersError
  if (followingError) throw followingError

  return {
    followers_count: Number(followersCount || 0),
    following_count: Number(followingCount || 0),
  }
}

async function isFollowingUser(followerUserId, followingUserId) {
  if (!followerUserId || !followingUserId) return false

  const { data, error } = await supabase
    .from('user_follows')
    .select('id')
    .eq('follower_user_id', followerUserId)
    .eq('following_user_id', followingUserId)
    .maybeSingle()

  if (error) throw error

  return Boolean(data)
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

    if (!isAllowedEmail(email)) {
  return res.status(400).json({
    ok: false,
    message: 'Only Gmail, Yahoo, Outlook, Hotmail, and iCloud accounts are allowed',
  })
}

    if (username.length < 3 || username.length > 30) {
  return res.status(400).json({
    ok: false,
    message: 'Username must be 3–30 characters.',
  })
}

if (!/^[A-Za-z0-9_]+$/.test(username)) {
  return res.status(400).json({
    ok: false,
    message: 'Username can only contain English letters, numbers, and underscores.',
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

    const [
  { data: existingEmail, error: emailLookupError },
  { data: existingUsername, error: usernameLookupError },
] = await Promise.all([
  supabase
    .from('users')
    .select('id')
    .eq('email', email)
    .maybeSingle(),
  supabase
    .from('users')
    .select('id')
    .ilike('username', escapeLikePattern(username))
    .maybeSingle(),
])

if (emailLookupError) throw emailLookupError
if (usernameLookupError) throw usernameLookupError

if (existingEmail) {
  return res.status(409).json({
    ok: false,
    message: 'Email already exists',
  })
}

if (existingUsername) {
  return res.status(409).json({
    ok: false,
    message: 'This username is already taken.',
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
        social_links: [],
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
        message: 'If this email exists, a reset code has been sent.',
        email_sent: true,
      })
    }

    await supabase
      .from('password_reset_tokens')
      .update({ used_at: new Date().toISOString() })
      .eq('user_id', user.id)
      .is('used_at', null)

    const otp = createResetOtp()
    const otpHash = hashResetOtp(user.email, otp)
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString()

    const { error: insertError } = await supabase
      .from('password_reset_tokens')
      .insert({
        user_id: user.id,
        token_hash: otpHash,
        expires_at: expiresAt,
        attempt_count: 0,
      })

    if (insertError) throw insertError

    const emailSent = await sendPasswordResetOtpEmail({ to: user.email, otp })

    return res.status(200).json({
      ok: true,
      message: 'If this email exists, a reset code has been sent.',
      email_sent: emailSent,
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
    const email = normalizeEmail(req.body.email)
    const otp = String(req.body.otp || '').trim()
    const password = String(req.body.password || '')
    const confirmPassword = String(req.body.confirmPassword || '')

    if (!email || !isValidEmail(email)) {
      return res.status(400).json({
        ok: false,
        message: 'Valid email is required',
      })
    }

    if (!/^\d{6}$/.test(otp)) {
      return res.status(400).json({
        ok: false,
        message: 'A valid 6-digit code is required',
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

    const { data: user, error: userError } = await supabase
      .from('users')
      .select('*')
      .eq('email', email)
      .eq('is_active', true)
      .maybeSingle()

    if (userError) throw userError

    if (!user) {
      return res.status(400).json({
        ok: false,
        message: 'Reset code is invalid or expired',
      })
    }

    const otpHash = hashResetOtp(email, otp)

    const { data: resetRow, error: resetError } = await supabase
      .from('password_reset_tokens')
      .select('id, user_id, token_hash, expires_at, used_at, attempt_count')
      .eq('user_id', user.id)
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
        .from('password_reset_tokens')
        .update({ used_at: new Date().toISOString() })
        .eq('id', resetRow.id)

      return res.status(400).json({
        ok: false,
        message: 'Too many wrong attempts. Please request a new code.',
      })
    }

    if (resetRow.token_hash !== otpHash) {
      await supabase
        .from('password_reset_tokens')
        .update({ attempt_count: Number(resetRow.attempt_count || 0) + 1 })
        .eq('id', resetRow.id)

      return res.status(400).json({
        ok: false,
        message: 'Reset code is incorrect',
      })
    }

    const passwordHash = hashPassword(password)
    const updatedAt = new Date().toISOString()

    const { data: updatedUser, error: updateUserError } = await supabase
      .from('users')
      .update({
        password_hash: passwordHash,
        updated_at: updatedAt,
      })
      .eq('id', user.id)
      .eq('is_active', true)
      .select()
      .single()

    if (updateUserError) throw updateUserError

    const { error: updateTokenError } = await supabase
      .from('password_reset_tokens')
      .update({ used_at: updatedAt })
      .eq('id', resetRow.id)

    if (updateTokenError) throw updateTokenError

    const authToken = createUserToken(updatedUser)

    return res.status(200).json({
      ok: true,
      message: 'Password reset successfully',
      token: authToken,
      user: publicUser(updatedUser),
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

export async function changePassword(req, res) {
  try {
    const userId = req.user?.user_id
    const currentPassword = String(req.body.current_password || req.body.currentPassword || '')
    const newPassword = String(req.body.new_password || req.body.newPassword || '')
    const confirmPassword = String(req.body.confirm_password || req.body.confirmPassword || '')

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    if (!currentPassword || !newPassword || !confirmPassword) {
      return res.status(400).json({
        ok: false,
        message: 'Current password, new password, and confirmation are required',
      })
    }

    if (newPassword.length < 6) {
      return res.status(400).json({
        ok: false,
        message: 'New password must be at least 6 characters',
      })
    }

    if (newPassword !== confirmPassword) {
      return res.status(400).json({
        ok: false,
        message: 'New password and confirm password do not match',
      })
    }

    if (currentPassword === newPassword) {
      return res.status(400).json({
        ok: false,
        message: 'New password must be different from current password',
      })
    }

    const { data: user, error: userError } = await supabase
      .from('users')
      .select('id, password_hash')
      .eq('id', userId)
      .eq('is_active', true)
      .maybeSingle()

    if (userError) throw userError

    if (!user) {
      return res.status(404).json({
        ok: false,
        message: 'User not found',
      })
    }

    if (!verifyPassword(currentPassword, user.password_hash)) {
      return res.status(401).json({
        ok: false,
        message: 'Current password is incorrect',
      })
    }

    const { error: updateError } = await supabase
      .from('users')
      .update({
        password_hash: hashPassword(newPassword),
        updated_at: new Date().toISOString(),
      })
      .eq('id', userId)
      .eq('is_active', true)

    if (updateError) throw updateError

    return res.status(200).json({
      ok: true,
      message: 'Password changed successfully',
    })
  } catch (error) {
    console.error('CHANGE PASSWORD ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to change password',
      error: error.message,
    })
  }
}


export async function requestEmailChange(req, res) {
  try {
    const userId = req.user?.user_id
    const currentPassword = String(
      req.body.current_password || req.body.currentPassword || ''
    )
    const newEmail = normalizeEmail(req.body.new_email || req.body.newEmail)

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    if (!currentPassword || !newEmail) {
      return res.status(400).json({
        ok: false,
        message: 'Current password and new email are required',
      })
    }

    if (!isValidEmail(newEmail)) {
      return res.status(400).json({
        ok: false,
        message: 'Email is not valid',
      })
    }

    if (!isAllowedEmail(newEmail)) {
      return res.status(400).json({
        ok: false,
        message: 'Only Gmail, Yahoo, Outlook, Hotmail, and iCloud accounts are allowed',
      })
    }

    const { data: user, error: userError } = await supabase
      .from('users')
      .select('id, email, password_hash, email_changed_at, is_active')
      .eq('id', userId)
      .eq('is_active', true)
      .maybeSingle()

    if (userError) throw userError

    if (!user) {
      return res.status(404).json({
        ok: false,
        message: 'User not found',
      })
    }

    if (!verifyPassword(currentPassword, user.password_hash)) {
      return res.status(401).json({
        ok: false,
        message: 'Current password is incorrect',
      })
    }

    if (newEmail === normalizeEmail(user.email)) {
      return res.status(400).json({
        ok: false,
        message: 'New email must be different from current email',
      })
    }

    if (user.email_changed_at) {
      const lastChangedAt = new Date(user.email_changed_at).getTime()
      const nextChangeAt = lastChangedAt + EMAIL_CHANGE_COOLDOWN_MS

      if (Number.isFinite(lastChangedAt) && Date.now() < nextChangeAt) {
        return res.status(429).json({
          ok: false,
          code: 'EMAIL_CHANGE_COOLDOWN',
          message: 'Email can only be changed once every 30 days',
          next_change_at: new Date(nextChangeAt).toISOString(),
        })
      }
    }

    const { data: existingUser, error: existingUserError } = await supabase
      .from('users')
      .select('id')
      .eq('email', newEmail)
      .neq('id', userId)
      .maybeSingle()

    if (existingUserError) throw existingUserError

    if (existingUser) {
      return res.status(409).json({
        ok: false,
        message: 'Email already exists',
      })
    }

    const nowIso = new Date().toISOString()

    const { error: invalidateError } = await supabase
      .from('email_change_tokens')
      .update({ used_at: nowIso })
      .eq('user_id', userId)
      .is('used_at', null)

    if (invalidateError) throw invalidateError

    const otp = createResetOtp()
    const otpHash = hashEmailChangeOtp(userId, newEmail, otp)
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString()

    const { data: tokenRow, error: insertError } = await supabase
      .from('email_change_tokens')
      .insert({
        user_id: userId,
        new_email: newEmail,
        token_hash: otpHash,
        expires_at: expiresAt,
        attempt_count: 0,
      })
      .select('id')
      .single()

    if (insertError) throw insertError

    const emailSent = await sendEmailChangeOtpEmail({
      to: newEmail,
      otp,
    })

    if (!emailSent) {
      await supabase
        .from('email_change_tokens')
        .update({ used_at: new Date().toISOString() })
        .eq('id', tokenRow.id)

      return res.status(503).json({
        ok: false,
        message: 'Email service is not available right now',
      })
    }

    return res.status(200).json({
      ok: true,
      message: 'Verification code sent to your new email',
      email_sent: true,
      new_email: newEmail,
      expires_at: expiresAt,
    })
  } catch (error) {
    console.error('REQUEST EMAIL CHANGE ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to request email change',
      error: error.message,
    })
  }
}

export async function confirmEmailChange(req, res) {
  try {
    const userId = req.user?.user_id
    const newEmail = normalizeEmail(req.body.new_email || req.body.newEmail)
    const otp = String(req.body.otp || '').trim()

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    if (!isValidEmail(newEmail)) {
      return res.status(400).json({
        ok: false,
        message: 'Email is not valid',
      })
    }

    if (!/^\d{6}$/.test(otp)) {
      return res.status(400).json({
        ok: false,
        message: 'A valid 6-digit code is required',
      })
    }

    const { data: user, error: userError } = await supabase
      .from('users')
      .select('*')
      .eq('id', userId)
      .eq('is_active', true)
      .maybeSingle()

    if (userError) throw userError

    if (!user) {
      return res.status(404).json({
        ok: false,
        message: 'User not found',
      })
    }

    if (newEmail === normalizeEmail(user.email)) {
      return res.status(400).json({
        ok: false,
        message: 'New email must be different from current email',
      })
    }

    if (user.email_changed_at) {
      const lastChangedAt = new Date(user.email_changed_at).getTime()
      const nextChangeAt = lastChangedAt + EMAIL_CHANGE_COOLDOWN_MS

      if (Number.isFinite(lastChangedAt) && Date.now() < nextChangeAt) {
        return res.status(429).json({
          ok: false,
          code: 'EMAIL_CHANGE_COOLDOWN',
          message: 'Email can only be changed once every 30 days',
          next_change_at: new Date(nextChangeAt).toISOString(),
        })
      }
    }

    const { data: tokenRow, error: tokenError } = await supabase
      .from('email_change_tokens')
      .select('id, new_email, token_hash, expires_at, used_at, attempt_count')
      .eq('user_id', userId)
      .eq('new_email', newEmail)
      .is('used_at', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (tokenError) throw tokenError

    if (!tokenRow || new Date(tokenRow.expires_at).getTime() < Date.now()) {
      if (tokenRow?.id) {
        await supabase
          .from('email_change_tokens')
          .update({ used_at: new Date().toISOString() })
          .eq('id', tokenRow.id)
      }

      return res.status(400).json({
        ok: false,
        message: 'Verification code is invalid or expired',
      })
    }

    if (Number(tokenRow.attempt_count || 0) >= 5) {
      await supabase
        .from('email_change_tokens')
        .update({ used_at: new Date().toISOString() })
        .eq('id', tokenRow.id)

      return res.status(400).json({
        ok: false,
        message: 'Too many wrong attempts. Please request a new code.',
      })
    }

    const otpHash = hashEmailChangeOtp(userId, newEmail, otp)

    if (tokenRow.token_hash !== otpHash) {
      const nextAttemptCount = Number(tokenRow.attempt_count || 0) + 1
      const updatePayload = {
        attempt_count: nextAttemptCount,
      }

      if (nextAttemptCount >= 5) {
        updatePayload.used_at = new Date().toISOString()
      }

      await supabase
        .from('email_change_tokens')
        .update(updatePayload)
        .eq('id', tokenRow.id)

      return res.status(400).json({
        ok: false,
        message:
          nextAttemptCount >= 5
            ? 'Too many wrong attempts. Please request a new code.'
            : 'Verification code is incorrect',
      })
    }

    const { data: existingUser, error: existingUserError } = await supabase
      .from('users')
      .select('id')
      .eq('email', newEmail)
      .neq('id', userId)
      .maybeSingle()

    if (existingUserError) throw existingUserError

    if (existingUser) {
      return res.status(409).json({
        ok: false,
        message: 'Email already exists',
      })
    }

    const now = new Date()
    const nowIso = now.toISOString()

    const { data: updatedUser, error: updateUserError } = await supabase
      .from('users')
      .update({
        email: newEmail,
        email_changed_at: nowIso,
        is_email_verified: true,
        updated_at: nowIso,
      })
      .eq('id', userId)
      .eq('is_active', true)
      .select()
      .single()

    if (updateUserError) throw updateUserError

    const { error: usedError } = await supabase
      .from('email_change_tokens')
      .update({ used_at: nowIso })
      .eq('user_id', userId)
      .is('used_at', null)

    if (usedError) throw usedError

    return res.status(200).json({
      ok: true,
      message: 'Email changed successfully',
      user: publicUser(updatedUser),
      token: createUserToken(updatedUser),
      next_change_at: new Date(
        now.getTime() + EMAIL_CHANGE_COOLDOWN_MS
      ).toISOString(),
    })
  } catch (error) {
    console.error('CONFIRM EMAIL CHANGE ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to change email',
      error: error.message,
    })
  }
}

export async function getMeSummary(req, res) {
  try {
    const userId = req.user?.user_id

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    const mailCutoff = new Date()
    mailCutoff.setDate(mailCutoff.getDate() - 365)

    const reminderCutoff = new Date()
    reminderCutoff.setDate(
      reminderCutoff.getDate() - 7
    )

    const [
      userResult,
      walletResult,
      authorPageResult,
      unreadResult,
      expiredReminderResult,
    ] = await Promise.all([
      supabase
        .from('users')
        .select(
          'id, name, username, email, email_changed_at, avatar_url, bio, work, location, social_links, date_of_birth, date_of_birth_updated_at, gender, custom_gender, role, is_author, is_active, is_email_verified, created_at, updated_at'
        )
        .eq('id', userId)
        .eq('is_active', true)
        .maybeSingle(),

      supabase
        .from('user_wallets')
        .select(
          'diamond_balance, gem_balance, voucher_balance'
        )
        .eq('user_id', userId)
        .maybeSingle(),

      supabase
        .from('author_pages')
        .select(
          'id, user_id, page_name, page_username, page_slug, bio, avatar_url, cover_url, status, total_stories, total_followers, created_at, updated_at'
        )
        .eq('user_id', userId)
        .maybeSingle(),

      supabase
        .from('reader_mails')
        .select('id', {
          count: 'exact',
          head: true,
        })
        .eq('user_id', userId)
        .eq('is_read', false)
        .is('deleted_at', null)
        .gte(
          'created_at',
          mailCutoff.toISOString()
        ),

      supabase
        .from('reader_mails')
        .select('id', {
          count: 'exact',
          head: true,
        })
        .eq('user_id', userId)
        .eq('is_read', false)
        .is('deleted_at', null)
        .gte(
          'created_at',
          mailCutoff.toISOString()
        )
        .lt(
          'created_at',
          reminderCutoff.toISOString()
        )
        .ilike(
          'reference_id',
          'daily_checkin_reminder_%'
        ),
    ])

    const error =
      userResult.error ||
      walletResult.error ||
      authorPageResult.error ||
      unreadResult.error ||
      expiredReminderResult.error

    if (error) throw error

    if (!userResult.data) {
      return res.status(404).json({
        ok: false,
        message: 'User not found',
      })
    }

    const wallet = walletResult.data || {}
    const coinBalance = Number(
      wallet.gem_balance || 0
    )
    const authorPage =
      authorPageResult.data || null
    const inboxUnreadCount = Math.max(
      0,
      Number(unreadResult.count || 0) -
        Number(
          expiredReminderResult.count || 0
        )
    )

    res.setHeader(
      'Cache-Control',
      'private, no-store'
    )

    return res.status(200).json({
      ok: true,
      user: publicUser(userResult.data),
      wallet: {
        diamond_balance: Number(
          wallet.diamond_balance || 0
        ),
        gem_balance: coinBalance,
        coin_balance: coinBalance,
        voucher_balance: Number(
          wallet.voucher_balance || 0
        ),
      },
      has_author_page: Boolean(authorPage),
      author_page: authorPage,
      inbox_unread_count: inboxUnreadCount,
    })
  } catch (error) {
    console.error(
      'GET ME SUMMARY ERROR:',
      error
    )

    return res.status(500).json({
      ok: false,
      message: 'Failed to load account summary',
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
    const socialLinks = normalizeProfileLinks(req.body.social_links || req.body.socialLinks)

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

    const { data: currentUser, error: currentUserError } = await supabase
      .from('users')
      .select('*')
      .eq('id', userId)
      .eq('is_active', true)
      .maybeSingle()

    if (currentUserError) throw currentUserError

    if (!currentUser) {
      return res.status(404).json({
        ok: false,
        message: 'User not found',
      })
    }

    const username =
      req.body.username === undefined
        ? currentUser.username
        : normalizeUsername(req.body.username)

    if (!username) {
      return res.status(400).json({
        ok: false,
        message: 'Username is required',
      })
    }

    if (username.length < 3 || username.length > 30) {
  return res.status(400).json({
    ok: false,
    message: 'Username must be 3–30 characters.',
  })
}

if (!/^[A-Za-z0-9_]+$/.test(username)) {
  return res.status(400).json({
    ok: false,
    message: 'Username can only contain English letters, numbers, and underscores.',
  })
}

    const now = new Date()
    const nowIso = now.toISOString()
    const isNameChanged = name !== String(currentUser.name || '').trim()
    const isUsernameChanged = username !== currentUser.username

    if (isNameChanged && currentUser.name_changed_at) {
      const nextNameChangeAt = new Date(currentUser.name_changed_at).getTime() + 14 * 24 * 60 * 60 * 1000

      if (now.getTime() < nextNameChangeAt) {
        return res.status(429).json({
          ok: false,
          message: 'Display name can only be changed once every 2 weeks',
        })
      }
    }

    if (isUsernameChanged && currentUser.username_changed_at) {
      const nextUsernameChangeAt = new Date(currentUser.username_changed_at).getTime() + 7 * 24 * 60 * 60 * 1000

      if (now.getTime() < nextUsernameChangeAt) {
        return res.status(429).json({
          ok: false,
          message: 'Username can only be changed once every 1 week',
        })
      }
    }

    if (isUsernameChanged) {
      const { data: existingUser, error: existingUserError } = await supabase
        .from('users')
        .select('id')
        .ilike('username', escapeLikePattern(username))
        .neq('id', userId)
        .maybeSingle()

      if (existingUserError) throw existingUserError

      if (existingUser) {
        return res.status(409).json({
          ok: false,
          message: 'Username already exists',
        })
      }
    }

    const updatePayload = {
      name,
      username,
      bio,
      work,
      location,
      social_links: socialLinks,
      updated_at: nowIso,
    }

    if (isNameChanged) updatePayload.name_changed_at = nowIso
    if (isUsernameChanged) updatePayload.username_changed_at = nowIso

    const { data, error } = await supabase
      .from('users')
      .update(updatePayload)
      .eq('id', userId)
      .eq('is_active', true)
      .select()
      .single()

    if (error) throw error

    return res.status(200).json({
      ok: true,
      message: 'Profile updated',
      user: publicUser(data),
      token: isUsernameChanged ? createUserToken(data) : undefined,
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

export async function updateDateOfBirth(req, res) {
  try {
    const userId = req.user?.user_id
    const dateOfBirth = String(
      req.body.date_of_birth || req.body.dateOfBirth || ''
    ).trim()

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateOfBirth)) {
      return res.status(400).json({
        ok: false,
        message: 'Date of birth is not valid',
      })
    }

    const birthDate = new Date(`${dateOfBirth}T00:00:00Z`)
    const normalizedDate = Number.isNaN(birthDate.getTime())
      ? ''
      : birthDate.toISOString().slice(0, 10)
    const age = calculateAge(dateOfBirth)

    if (
      normalizedDate !== dateOfBirth ||
      age === null ||
      age < 0 ||
      age > 120
    ) {
      return res.status(400).json({
        ok: false,
        message: 'Date of birth is not valid',
      })
    }

    const { data: currentUser, error: currentUserError } = await supabase
      .from('users')
      .select('*')
      .eq('id', userId)
      .eq('is_active', true)
      .maybeSingle()

    if (currentUserError) throw currentUserError

    if (!currentUser) {
      return res.status(404).json({
        ok: false,
        message: 'User not found',
      })
    }

    if (String(currentUser.date_of_birth || '') === dateOfBirth) {
      return res.status(200).json({
        ok: true,
        message: 'Date of birth is unchanged',
        user: publicUser(currentUser),
      })
    }

    const now = new Date()
    const nowIso = now.toISOString()
    const cooldownMs = 7 * 24 * 60 * 60 * 1000

    if (currentUser.date_of_birth_updated_at) {
      const lastChangedAt = new Date(
        currentUser.date_of_birth_updated_at
      ).getTime()
      const nextChangeAt = lastChangedAt + cooldownMs

      if (Number.isFinite(lastChangedAt) && now.getTime() < nextChangeAt) {
        return res.status(429).json({
          ok: false,
          code: 'DATE_OF_BIRTH_CHANGE_COOLDOWN',
          message: 'Date of birth can only be changed once every 7 days',
          next_change_at: new Date(nextChangeAt).toISOString(),
        })
      }
    }

    const { data, error } = await supabase
      .from('users')
      .update({
        date_of_birth: dateOfBirth,
        date_of_birth_updated_at: nowIso,
        updated_at: nowIso,
      })
      .eq('id', userId)
      .eq('is_active', true)
      .select()
      .single()

    if (error) throw error

    return res.status(200).json({
      ok: true,
      message: 'Date of birth updated',
      user: publicUser(data),
      next_change_at: new Date(
        now.getTime() + cooldownMs
      ).toISOString(),
    })
  } catch (error) {
    console.error('UPDATE DATE OF BIRTH ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to update date of birth',
      error: error.message,
    })
  }
}



export async function updatePaymentProfile(req, res) {
  try {
    const userId = req.user?.user_id
    const paymentAccountName = String(req.body.payment_account_name || '').trim().toUpperCase()

    if (!userId) {
      return res.status(401).json({ ok: false, message: 'Unauthorized' })
    }

    if (!paymentAccountName || paymentAccountName.length < 2) {
      return res.status(400).json({ ok: false, message: 'Payment account name is required' })
    }

    if (paymentAccountName.length > 80) {
      return res.status(400).json({ ok: false, message: 'Payment account name must be 80 characters or less' })
    }

    const { data, error } = await supabase
      .from('users')
      .update({
        payment_account_name: paymentAccountName,
        updated_at: new Date().toISOString(),
      })
      .eq('id', userId)
      .eq('is_active', true)
      .select()
      .single()

    if (error) throw error

    return res.status(200).json({
      ok: true,
      message: 'Payment profile saved',
      user: publicUser(data),
    })
  } catch (error) {
    console.error('UPDATE PAYMENT PROFILE ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to save payment profile',
      error: error.message,
    })
  }
}

export async function getPublicUserProfile(req, res) {
  try {
    const currentUserId = req.user?.user_id || ''
    const username = normalizeUsername(req.params.username)

    if (!username) {
      return res.status(400).json({
        ok: false,
        message: 'Username is required',
      })
    }

    const { data: user, error } = await supabase
      .from('users')
      .select('*')
      .eq('username', username)
      .eq('is_active', true)
      .maybeSingle()

    if (error) throw error

    if (!user) {
      return res.status(404).json({
        ok: false,
        message: 'User not found',
      })
    }

    const [counts, isFollowing] = await Promise.all([
      getUserFollowCounts(user.id),
      isFollowingUser(currentUserId, user.id),
    ])

    return res.status(200).json({
      ok: true,
      user: publicUserProfile(user, counts, isFollowing),
    })
  } catch (error) {
    console.error('GET PUBLIC USER PROFILE ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to fetch profile',
      error: error.message,
    })
  }
}

export async function followUser(req, res) {
  try {
    const followerUserId = req.user?.user_id
    const username = normalizeUsername(req.params.username)

    if (!followerUserId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    if (!username) {
      return res.status(400).json({
        ok: false,
        message: 'Username is required',
      })
    }

    const { data: targetUser, error: targetError } = await supabase
      .from('users')
      .select('*')
      .eq('username', username)
      .eq('is_active', true)
      .maybeSingle()

    if (targetError) throw targetError

    if (!targetUser) {
      return res.status(404).json({
        ok: false,
        message: 'User not found',
      })
    }

    if (targetUser.id === followerUserId) {
      return res.status(400).json({
        ok: false,
        message: 'You cannot follow yourself',
      })
    }

    const { error: followError } = await supabase
      .from('user_follows')
      .insert({
        follower_user_id: followerUserId,
        following_user_id: targetUser.id,
      })

    if (followError && followError.code !== '23505') throw followError

    const counts = await getUserFollowCounts(targetUser.id)

    return res.status(200).json({
      ok: true,
      message: 'User followed',
      is_following: true,
      ...counts,
    })
  } catch (error) {
    console.error('FOLLOW USER ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to follow user',
      error: error.message,
    })
  }
}

export async function unfollowUser(req, res) {
  try {
    const followerUserId = req.user?.user_id
    const username = normalizeUsername(req.params.username)

    if (!followerUserId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    if (!username) {
      return res.status(400).json({
        ok: false,
        message: 'Username is required',
      })
    }

    const { data: targetUser, error: targetError } = await supabase
      .from('users')
      .select('*')
      .eq('username', username)
      .eq('is_active', true)
      .maybeSingle()

    if (targetError) throw targetError

    if (!targetUser) {
      return res.status(404).json({
        ok: false,
        message: 'User not found',
      })
    }

    const { error: deleteError } = await supabase
      .from('user_follows')
      .delete()
      .eq('follower_user_id', followerUserId)
      .eq('following_user_id', targetUser.id)

    if (deleteError) throw deleteError

    const counts = await getUserFollowCounts(targetUser.id)

    return res.status(200).json({
      ok: true,
      message: 'User unfollowed',
      is_following: false,
      ...counts,
    })
  } catch (error) {
    console.error('UNFOLLOW USER ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to unfollow user',
      error: error.message,
    })
  }
}

function normalizePage(value, fallback = 1) {
  const number = Number(value)

  if (!Number.isFinite(number) || number <= 0) return fallback

  return Math.floor(number)
}

function normalizeListLimit(value, fallback = 20, max = 50) {
  const number = Number(value)

  if (!Number.isFinite(number) || number <= 0) return fallback

  return Math.min(Math.floor(number), max)
}

function publicFollowUser(user, isFollowing = false, isFollowedBy = false) {
  return {
    id: user.id,
    name: user.name,
    username: user.username,
    avatar_url: user.avatar_url || null,
    bio: user.bio || '',
    work: user.work || '',
    location: user.location || '',
    is_author: Boolean(user.is_author),
    is_premium: Boolean(user.is_premium),
    is_following: Boolean(isFollowing),
    is_followed_by: Boolean(isFollowedBy),
    can_follow_back: Boolean(isFollowedBy && !isFollowing),
  }
}

async function getUserByUsername(username) {
  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('username', username)
    .eq('is_active', true)
    .maybeSingle()

  if (error) throw error

  return data
}

async function enrichFollowUsers(users, currentUserId) {
  return Promise.all(
    users.map(async (user) => {
      const [isFollowing, isFollowedBy] = await Promise.all([
        isFollowingUser(currentUserId, user.id),
        isFollowingUser(user.id, currentUserId),
      ])

      return publicFollowUser(user, isFollowing, isFollowedBy)
    })
  )
}

export async function getUserFollowers(req, res) {
  try {
    const currentUserId = req.user?.user_id || ''
    const username = normalizeUsername(req.params.username)
    const q = String(req.query.q || '').trim()
    const page = normalizePage(req.query.page)
    const limit = normalizeListLimit(req.query.limit)
    const from = (page - 1) * limit
    const to = from + limit - 1

    if (!username) {
      return res.status(400).json({
        ok: false,
        message: 'Username is required',
      })
    }

    const targetUser = await getUserByUsername(username)

    if (!targetUser) {
      return res.status(404).json({
        ok: false,
        message: 'User not found',
      })
    }

    let query = supabase
      .from('user_follows')
      .select('follower:users!user_follows_follower_user_id_fkey(id, name, username, avatar_url, bio, work, location, is_author)', { count: 'exact' })
      .eq('following_user_id', targetUser.id)
      .order('created_at', { ascending: false })

    if (q) {
      query = query.or(`name.ilike.%${q}%,username.ilike.%${q}%`, {
        foreignTable: 'follower',
      })
    }

    const { data, error, count } = await query.range(from, to)

    if (error) throw error

    const users = (data || []).map((item) => item.follower).filter(Boolean)
    const usersWithFollowStatus = await enrichFollowUsers(users, currentUserId)

    return res.status(200).json({
      ok: true,
      users: usersWithFollowStatus,
      page,
      limit,
      total: Number(count || 0),
      has_next: to + 1 < Number(count || 0),
    })
  } catch (error) {
    console.error('GET USER FOLLOWERS ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load followers',
      error: error.message,
    })
  }
}

export async function getUserFollowing(req, res) {
  try {
    const currentUserId = req.user?.user_id || ''
    const username = normalizeUsername(req.params.username)
    const q = String(req.query.q || '').trim()
    const page = normalizePage(req.query.page)
    const limit = normalizeListLimit(req.query.limit)
    const from = (page - 1) * limit
    const to = from + limit - 1

    if (!username) {
      return res.status(400).json({
        ok: false,
        message: 'Username is required',
      })
    }

    const targetUser = await getUserByUsername(username)

    if (!targetUser) {
      return res.status(404).json({
        ok: false,
        message: 'User not found',
      })
    }

    let query = supabase
      .from('user_follows')
      .select('following:users!user_follows_following_user_id_fkey(id, name, username, avatar_url, bio, work, location, is_author)', { count: 'exact' })
      .eq('follower_user_id', targetUser.id)
      .order('created_at', { ascending: false })

    if (q) {
      query = query.or(`name.ilike.%${q}%,username.ilike.%${q}%`, {
        foreignTable: 'following',
      })
    }

    const { data, error, count } = await query.range(from, to)

    if (error) throw error

    const users = (data || []).map((item) => item.following).filter(Boolean)
    const usersWithFollowStatus = await enrichFollowUsers(users, currentUserId)

    return res.status(200).json({
      ok: true,
      users: usersWithFollowStatus,
      page,
      limit,
      total: Number(count || 0),
      has_next: to + 1 < Number(count || 0),
    })
  } catch (error) {
    console.error('GET USER FOLLOWING ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load following',
      error: error.message,
    })
  }
}

export async function getUserSuggestions(req, res) {
  try {
    const currentUserId = req.user?.user_id || ''
    const q = String(req.query.q || '').trim()
    const page = normalizePage(req.query.page)
    const limit = normalizeListLimit(req.query.limit)
    const from = (page - 1) * limit
    const fetchLimit = limit * 4

    if (!currentUserId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    const { data: followingRows, error: followingError } = await supabase
      .from('user_follows')
      .select('following_user_id')
      .eq('follower_user_id', currentUserId)

    if (followingError) throw followingError

    const followingIds = new Set(
      (followingRows || []).map((item) => item.following_user_id)
    )

    let query = supabase
      .from('users')
      .select('id, name, username, avatar_url, bio, work, location, is_author, created_at')
      .eq('is_active', true)
      .neq('id', currentUserId)
      .order('created_at', { ascending: false })
      .range(0, fetchLimit - 1)

    if (q) {
      query = query.or(`name.ilike.%${q}%,username.ilike.%${q}%`)
    }

    const { data, error } = await query

    if (error) throw error

    const suggestions = (data || [])
      .filter((user) => !followingIds.has(user.id))
      .slice(from, from + limit)

    const users = suggestions.map((user) => publicFollowUser(user, false, false))

    return res.status(200).json({
      ok: true,
      users,
      page,
      limit,
      total: users.length,
      has_next: users.length === limit,
    })
  } catch (error) {
    console.error('GET USER SUGGESTIONS ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load suggestions',
      error: error.message,
    })
  }
}
