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

function publicUserProfile(user, counts = {}, isFollowing = false) {
  return {
    ...publicUser(user),
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
      .select('id, user_id, expires_at, used_at, attempt_count')
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

export async function getPublicUserProfile(req, res) {
  try {
const currentUserId = req.user?.user_id || ''
const username = normalizeUsername(req.params.username)

if (!username) {
  return res.status(400).json({ ok: false, message: 'Username is required' })
}

const { data: user, error } = await supabase
  .from('users')
  .select('*')
  .eq('username', username)
  .eq('is_active', true)
  .maybeSingle()

if (error) throw error

if (!user) {
  return res.status(404).json({ ok: false, message: 'User not found' })
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
return res.status(500).json({ ok: false, message: 'Failed to fetch profile', error: error.message })
  }
}

export async function followUser(req, res) {
  try {
const followerUserId = req.user?.user_id
const username = normalizeUsername(req.params.username)

if (!followerUserId) {
  return res.status(401).json({ ok: false, message: 'Unauthorized' })
}

const { data: targetUser, error: targetError } = await supabase
  .from('users')
  .select('*')
  .eq('username', username)
  .eq('is_active', true)
  .maybeSingle()

if (targetError) throw targetError

if (!targetUser) {
  return res.status(404).json({ ok: false, message: 'User not found' })
}

if (targetUser.id === followerUserId) {
  return res.status(400).json({ ok: false, message: 'You cannot follow yourself' })
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
return res.status(500).json({ ok: false, message: 'Failed to follow user', error: error.message })
  }
}

export async function unfollowUser(req, res) {
  try {
const followerUserId = req.user?.user_id
const username = normalizeUsername(req.params.username)

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

function publicFollowUser(user) {
  return {
    id: user.id,
    name: user.name,
    username: user.username,
    avatar_url: user.avatar_url || null,
    bio: user.bio || '',
    is_author: Boolean(user.is_author),
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

export async function getUserFollowers(req, res) {
  try {
    const currentUserId = req.user?.user_id || ''
    const username = normalizeUsername(req.params.username)
    const q = String(req.query.q || '').trim()
    const page = normalizePage(req.query.page)
    const limit = normalizeListLimit(req.query.limit)
    const from = (page - 1) * limit
    const to = from + limit - 1

    const targetUser = await getUserByUsername(username)

    if (!targetUser) {
      return res.status(404).json({ ok: false, message: 'User not found' })
    }

    const { data, error, count } = await supabase
      .from('user_follows')
      .select('follower:users!user_follows_follower_user_id_fkey(id, name, username, avatar_url, bio, is_author)', { count: 'exact' })
      .eq('following_user_id', targetUser.id)
      .order('created_at', { ascending: false })
      .range(from, to)

    if (error) throw error

    let users = (data || []).map((item) => item.follower).filter(Boolean)

    if (q) {
      const keyword = q.toLowerCase()
      users = users.filter((user) => {
        return (
          String(user.name || '').toLowerCase().includes(keyword) ||
          String(user.username || '').toLowerCase().includes(keyword)
        )
      })
    }

    const usersWithFollowStatus = await Promise.all(
      users.map(async (user) => ({
        ...publicFollowUser(user),
        is_following: await isFollowingUser(currentUserId, user.id),
      }))
    )

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
    return res.status(500).json({ ok: false, message: 'Failed to load followers', error: error.message })
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

    const targetUser = await getUserByUsername(username)

    if (!targetUser) {
      return res.status(404).json({ ok: false, message: 'User not found' })
    }

    const { data, error, count } = await supabase
      .from('user_follows')
      .select('following:users!user_follows_following_user_id_fkey(id, name, username, avatar_url, bio, is_author)', { count: 'exact' })
      .eq('follower_user_id', targetUser.id)
      .order('created_at', { ascending: false })
      .range(from, to)

    if (error) throw error

    let users = (data || []).map((item) => item.following).filter(Boolean)

    if (q) {
      const keyword = q.toLowerCase()
      users = users.filter((user) => {
        return (
          String(user.name || '').toLowerCase().includes(keyword) ||
          String(user.username || '').toLowerCase().includes(keyword)
        )
      })
    }

    const usersWithFollowStatus = await Promise.all(
      users.map(async (user) => ({
        ...publicFollowUser(user),
        is_following: await isFollowingUser(currentUserId, user.id),
      }))
    )

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
    return res.status(500).json({ ok: false, message: 'Failed to load following', error: error.message })
  }
}

if (!followerUserId) {
  return res.status(401).json({ ok: false, message: 'Unauthorized' })
}

const { data: targetUser, error: targetError } = await supabase
  .from('users')
  .select('*')
  .eq('username', username)
  .eq('is_active', true)
  .maybeSingle()

if (targetError) throw targetError

if (!targetUser) {
  return res.status(404).json({ ok: false, message: 'User not found' })
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
return res.status(500).json({ ok: false, message: 'Failed to unfollow user', error: error.message })
  }
}
