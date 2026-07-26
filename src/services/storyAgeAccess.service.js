import jwt from 'jsonwebtoken'
import { supabase } from '../config/supabase.js'

const ADULT_AGE = 18

function calculateAge(dateOfBirth) {
  const birthDate = new Date(dateOfBirth)
  const today = new Date()

  if (Number.isNaN(birthDate.getTime())) return null

  let age = today.getFullYear() - birthDate.getFullYear()
  const monthDifference = today.getMonth() - birthDate.getMonth()

  if (
    monthDifference < 0 ||
    (monthDifference === 0 && today.getDate() < birthDate.getDate())
  ) {
    age -= 1
  }

  return age
}

function getOptionalReaderUserId(req) {
  const authenticatedUserId =
    req?.user?.user_id ||
    req?.user?.id ||
    null

  if (authenticatedUserId) return authenticatedUserId

  try {
    const authorization = String(req?.headers?.authorization || '')
    const token = authorization.startsWith('Bearer ')
      ? authorization.slice(7)
      : ''

    if (!token || !process.env.JWT_SECRET) return null

    const decoded = jwt.verify(token, process.env.JWT_SECRET)

    if (decoded?.type !== 'reader') return null

    return decoded.user_id || decoded.id || null
  } catch {
    return null
  }
}

export async function getReaderAgeAccessByUserId(userId) {
  if (!userId) {
    return {
      user_id: null,
      age: null,
      can_view_adult_stories: false,
    }
  }

  const { data, error } = await supabase
    .from('users')
    .select('id, date_of_birth, is_active')
    .eq('id', userId)
    .eq('is_active', true)
    .maybeSingle()

  if (error) throw error

  const age = data?.date_of_birth
    ? calculateAge(data.date_of_birth)
    : null

  return {
    user_id: data?.id || userId,
    age,
    can_view_adult_stories:
      Number.isFinite(age) && age >= ADULT_AGE,
  }
}

export async function getReaderAgeAccess(req) {
  if (req?.readerAgeAccess) return req.readerAgeAccess

  const access = await getReaderAgeAccessByUserId(
    getOptionalReaderUserId(req)
  )

  if (req) req.readerAgeAccess = access

  return access
}

export function isStoryVisibleToReader(story, access) {
  if (!story) return false
  if (!Boolean(story.is_adult)) return true

  return Boolean(access?.can_view_adult_stories)
}

export function applyAdultStoryVisibility(query, access) {
  if (access?.can_view_adult_stories) return query

  return query.or(
    'is_adult.is.null,is_adult.eq.false'
  )
}

export function hideAdultStory(res) {
  return res.status(404).json({
    ok: false,
    message: 'Story not found',
  })
}
