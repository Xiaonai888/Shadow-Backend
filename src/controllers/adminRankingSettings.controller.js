import { supabase } from '../config/supabase.js'

const NUMERIC_FIELDS = [
  'story_view_weight',
  'story_like_weight',
  'story_comment_weight',
  'story_episode_weight',
  'author_view_weight',
  'author_like_weight',
  'author_comment_weight',
  'author_follower_weight',
  'author_story_weight',
  'episode_view_weight',
  'episode_like_weight',
  'episode_comment_weight',
  'min_story_views',
  'min_story_likes',
  'min_story_comments',
  'min_story_episodes',
  'min_author_stories',
  'min_author_followers',
  'min_episode_views',
  'min_episode_likes',
  'min_episode_comments',
]

const BOOLEAN_FIELDS = [
  'story_rank_enabled',
  'genre_rank_enabled',
  'author_rank_enabled',
  'episode_rank_enabled',
]

function cleanText(value) {
  return String(value || '').trim()
}

function adminActor(req) {
  return cleanText(
    req.admin?.email ||
      req.admin?.username ||
      req.admin?.admin_name ||
      req.admin?.user_id ||
      req.headers['x-admin-name'] ||
      req.headers['x-admin-actor'] ||
      'Admin'
  )
}

async function loadSettings() {
  const { data, error } = await supabase
    .from('ranking_settings')
    .select('*')
    .eq('id', 1)
    .maybeSingle()

  if (error) throw error

  if (data) return data

  const { data: created, error: createError } = await supabase
    .from('ranking_settings')
    .insert({ id: 1 })
    .select()
    .single()

  if (createError) throw createError
  return created
}

export async function getAdminRankingSettings(req, res) {
  try {
    const settings = await loadSettings()

    return res.status(200).json({
      ok: true,
      settings,
    })
  } catch (error) {
    console.error('GET ADMIN RANKING SETTINGS ERROR:', error)
    return res.status(500).json({
      ok: false,
      message: 'Failed to load ranking settings',
      error: error.message,
    })
  }
}

export async function updateAdminRankingSettings(req, res) {
  try {
    const payload = {}

    for (const field of NUMERIC_FIELDS) {
      if (!(field in req.body)) continue

      const value = Number(req.body[field])
      if (!Number.isFinite(value) || value < 0) {
        return res.status(400).json({
          ok: false,
          message: `Invalid value for ${field}`,
        })
      }

      payload[field] = value
    }

    for (const field of BOOLEAN_FIELDS) {
      if (!(field in req.body)) continue

      if (typeof req.body[field] !== 'boolean') {
        return res.status(400).json({
          ok: false,
          message: `Invalid value for ${field}`,
        })
      }

      payload[field] = req.body[field]
    }

    if (!Object.keys(payload).length) {
      return res.status(400).json({
        ok: false,
        message: 'No valid ranking settings supplied',
      })
    }

    payload.updated_at = new Date().toISOString()
    payload.updated_by = adminActor(req)

    const { data: settings, error } = await supabase
      .from('ranking_settings')
      .update(payload)
      .eq('id', 1)
      .select()
      .single()

    if (error) throw error

    return res.status(200).json({
      ok: true,
      message: 'Ranking settings updated',
      settings,
    })
  } catch (error) {
    console.error('UPDATE ADMIN RANKING SETTINGS ERROR:', error)
    return res.status(500).json({
      ok: false,
      message: 'Failed to update ranking settings',
      error: error.message,
    })
  }
}
