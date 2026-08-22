import { supabase } from '../config/supabase.js'
import { getReaderAgeAccess } from '../services/storyAgeAccess.service.js'

function normalizeLimit(value, fallback = 6, max = 24) {
  const number = Number(value)

  if (!Number.isFinite(number) || number <= 0) {
    return fallback
  }

  return Math.min(Math.floor(number), max)
}

function normalizeStoryType(value) {
  const storyType = String(value || '')
    .trim()
    .toLowerCase()

  return ['novel', 'manga', 'chat_story'].includes(storyType)
    ? storyType
    : null
}

export async function getPublicWeeklyUpdates(req, res) {
  try {
    const limit = normalizeLimit(req.query.limit)
    const language = String(req.query.language || '').trim() || null
    const storyType = normalizeStoryType(
      req.query.story_type || req.query.storyType
    )
    const ageAccess = await getReaderAgeAccess(req)

    const { data, error } = await supabase.rpc(
      'get_public_weekly_story_updates',
      {
        p_language: language,
        p_story_type: storyType,
        p_include_adult: Boolean(
          ageAccess?.can_view_adult_stories
        ),
        p_limit: limit,
      }
    )

    if (error) throw error

    res.set(
      'Cache-Control',
      'private, max-age=60, stale-while-revalidate=300'
    )

    return res.status(200).json({
      ok: true,
      stories: (data || []).map((story) => ({
        id: story.id,
        title: story.title || 'Untitled Story',
        cover_url: story.cover_url || null,
        landscape_thumbnail_url:
          story.landscape_thumbnail_url || null,
        weekly_update_count: Number(
          story.weekly_update_count || 0
        ),
        last_episode_published_at:
          story.last_episode_published_at || null,
      })),
    })
  } catch (error) {
    console.error('GET PUBLIC WEEKLY UPDATES ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load weekly updates',
      error: error.message,
    })
  }
}
