import { supabase } from '../config/supabase.js'
import { getReaderAgeAccess } from '../services/storyAgeAccess.service.js'

function normalizePositiveInteger(value, fallback, max) {
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

function getCambodiaDateKey() {
  return new Date().toLocaleDateString('en-CA', {
    timeZone: 'Asia/Phnom_Penh',
  })
}

export async function getPublicStoryUpdates(req, res) {
  try {
    const days = normalizePositiveInteger(req.query.days, 7, 7)
    const limitPerDay = normalizePositiveInteger(
      req.query.limit_per_day || req.query.limitPerDay,
      100,
      100
    )
    const language = String(req.query.language || '').trim() || null
    const storyType = normalizeStoryType(
      req.query.story_type || req.query.storyType
    )
    const ageAccess = await getReaderAgeAccess(req)

    const { data, error } = await supabase.rpc(
      'get_public_story_updates',
      {
        p_language: language,
        p_story_type: storyType,
        p_include_adult: Boolean(
          ageAccess?.can_view_adult_stories
        ),
        p_days: days,
        p_limit_per_day: limitPerDay,
      }
    )

    if (error) throw error

    res.set('Cache-Control', 'private, no-store')

    return res.status(200).json({
      ok: true,
      today: getCambodiaDateKey(),
      days,
      stories: (data || []).map((story) => ({
        id: story.id,
        title: story.title || 'Untitled Story',
        cover_url: story.cover_url || null,
        main_genre: story.main_genre || '',
        tags: Array.isArray(story.tags) ? story.tags : [],
        story_status: story.story_status || 'New',
        author_id: story.author_id || null,
        author_name: story.author_name || 'Shadow Author',
        total_episodes: Number(story.total_episodes || 0),
        update_date: story.update_date,
        daily_update_count: Number(
          story.daily_update_count || 0
        ),
        last_episode_published_at:
          story.last_episode_published_at || null,
      })),
    })
  } catch (error) {
    console.error('GET PUBLIC STORY UPDATES ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load story updates',
      error: error.message,
    })
  }
}
