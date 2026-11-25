import { supabase } from '../config/supabase.js'
import { applyAdultStoryVisibility } from './storyAgeAccess.service.js'

const DAY_MS = 86400000
const KH_OFFSET_MS = 7 * 3600000
const MIDNIGHT_GRACE_MS = 10 * 60000
const POOL_LIMIT = 30
const DISPLAY_LIMIT = 9
const LANGUAGES = new Set(['Khmer', 'English', 'Chinese', 'Japanese', 'Korean'])
const TYPES = new Set(['', 'novel', 'manga', 'chat_story'])
const pools = new Map()
const pending = new Map()

function getDayNumber(now = Date.now()) {
  return Math.floor((now + KH_OFFSET_MS) / DAY_MS)
}

function getDayLabel(day) {
  return new Date(day * DAY_MS).toISOString().slice(0, 10)
}

function getExpiry(day, now) {
  const midnight = day * DAY_MS - KH_OFFSET_MS
  if (now < midnight + MIDNIGHT_GRACE_MS) {
    return midnight + MIDNIGHT_GRACE_MS
  }
  return midnight + DAY_MS
}

async function loadPool(language, storyType, canViewAdult) {
  const key = JSON.stringify([language, storyType, canViewAdult])
  const now = Date.now()
  const day = getDayNumber(now)
  const cached = pools.get(key)
  if (cached?.day === day && cached.expiresAt > now) return cached.rows

  const pendingKey = JSON.stringify([key, day, getExpiry(day, now)])
  if (pending.has(pendingKey)) return pending.get(pendingKey)

  const request = (async () => {
    const { data, error } = await supabase.rpc('get_trending_story_pool_v1', {
      p_language: language,
      p_story_type: storyType,
      p_can_view_adult: canViewAdult,
    })
    if (error) throw error

    const rows = (Array.isArray(data) ? data : [])
      .filter((row) => row?.story_id)
      .sort((a, b) => Number(b.score) - Number(a.score) ||
        Number(b.activity_7) - Number(a.activity_7) ||
        Number(b.activity_30) - Number(a.activity_30) ||
        String(a.story_id).localeCompare(String(b.story_id)))
      .slice(0, POOL_LIMIT)

    const expiresAt = getExpiry(day, now)
    if (getDayNumber() === day && Date.now() < expiresAt) {
      pools.set(key, { day, expiresAt, rows })
    }
    return rows
  })()

  pending.set(pendingKey, request)
  try {
    return await request
  } finally {
    pending.delete(pendingKey)
  }
}

function rotateStories(stories, day) {
  const featured = stories.slice(0, 3)
  const rest = stories.slice(3)
  const take = Math.min(DISPLAY_LIMIT - featured.length, rest.length)
  const offset = rest.length ? (day * 6) % rest.length : 0
  const selected = featured.concat(
    Array.from({ length: take }, (_, index) => rest[(offset + index) % rest.length])
  )
  const shift = selected.length ? day % selected.length : 0
  return selected.slice(shift).concat(selected.slice(0, shift))
}

export async function getTrendingStoryPool({ language, storyType = '', ageAccess }) {
  if (!LANGUAGES.has(language) || !TYPES.has(storyType)) {
    const error = new Error('Invalid trending story scope')
    error.code = 'INVALID_TRENDING_SCOPE'
    throw error
  }

  const canViewAdult = Boolean(ageAccess?.can_view_adult_stories)
  const day = getDayNumber()
  const pool = await loadPool(language, storyType, canViewAdult)
  const ids = [...new Set(pool.map((row) => row.story_id))]

  if (!ids.length) return { stories: [], rotation_day: getDayLabel(day) }

  let query = supabase
    .from('shadow_reader_visible_stories_v1')
    .select('id,title,cover_url,landscape_thumbnail_url,main_genre,is_adult,story_language,story_type')
    .in('id', ids)
    .eq('status', 'published')
    .is('deleted_at', null)
    .or('is_shadow_exclusive.is.null,is_shadow_exclusive.eq.false')
    .or('ranking_visibility_status.is.null,ranking_visibility_status.eq.visible')
    .eq('story_language', language)

  if (storyType) query = query.eq('story_type', storyType)
  query = applyAdultStoryVisibility(query, ageAccess)

  const { data, error } = await query
  if (error) throw error

  const byId = new Map((data || []).map((story) => [String(story.id), story]))
  const stories = ids.map((id) => byId.get(String(id))).filter(Boolean)

  return { stories: rotateStories(stories, day), rotation_day: getDayLabel(day) }
}
