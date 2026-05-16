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
