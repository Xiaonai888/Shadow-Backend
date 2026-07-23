import { supabase } from '../config/supabase.js'

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || '').trim()
  )
}

function clampPercent(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return 0
  return Math.min(100, Math.max(0, Math.round(number)))
}

export async function getReadingProgress(req, res) {
  try {
    const userId = String(req.user?.user_id || '').trim()
    const limit = Math.min(30, Math.max(1, Number(req.query.limit || 12)))

    const { data: rows, error } = await supabase
      .from('reading_progress')
      .select(
        'id, story_id, episode_id, episode_number, total_episodes, reading_percent, last_read_at'
      )
      .eq('user_id', userId)
      .order('last_read_at', { ascending: false })
      .limit(limit)

    if (error) throw error

    const progressRows = Array.isArray(rows) ? rows : []
    if (!progressRows.length) {
      return res.json({ ok: true, items: [] })
    }

    const storyIds = [...new Set(progressRows.map((item) => item.story_id).filter(Boolean))]
    const episodeIds = [...new Set(progressRows.map((item) => item.episode_id).filter(Boolean))]

    const [
      { data: stories, error: storiesError },
      { data: episodes, error: episodesError },
    ] = await Promise.all([
      supabase
        .from('stories')
        .select(
  'id, title, cover_url, landscape_thumbnail_url, total_episodes, story_status, story_type'
)
        .in('id', storyIds)
        .eq('status', 'published')
        .is('deleted_at', null),
      supabase
        .from('episodes')
        .select('id, story_id, title, episode_number')
        .in('id', episodeIds)
        .eq('status', 'published')
        .is('deleted_at', null),
    ])

    if (storiesError) throw storiesError
    if (episodesError) throw episodesError

    const storyMap = new Map((stories || []).map((story) => [String(story.id), story]))
    const episodeMap = new Map((episodes || []).map((episode) => [String(episode.id), episode]))

    const items = progressRows
      .map((row) => {
        const story = storyMap.get(String(row.story_id))
        const episode = episodeMap.get(String(row.episode_id))

        if (!story || !episode) return null

        return {
          ...row,
          total_episodes: Math.max(
            1,
            Number(story.total_episodes || row.total_episodes || 1)
          ),
          story,
          episode,
        }
      })
      .filter(Boolean)

    return res.json({ ok: true, items })
  } catch (error) {
    console.error('GET_READING_PROGRESS_ERROR', error)
    return res.status(500).json({
      ok: false,
      message: 'Failed to load reading progress',
    })
  }
}

export async function saveReadingProgress(req, res) {
  try {
    const userId = String(req.user?.user_id || '').trim()
    const storyId = String(req.body.story_id || '').trim()
    const episodeId = String(req.body.episode_id || '').trim()
    const readingPercent = clampPercent(req.body.reading_percent)

    if (!isUuid(storyId) || !isUuid(episodeId)) {
      return res.status(400).json({
        ok: false,
        message: 'Valid story_id and episode_id are required',
      })
    }

    const [
      { data: story, error: storyError },
      { data: episode, error: episodeError },
    ] = await Promise.all([
      supabase
        .from('stories')
        .select('id, total_episodes')
        .eq('id', storyId)
        .eq('status', 'published')
        .is('deleted_at', null)
        .maybeSingle(),
      supabase
        .from('episodes')
        .select('id, story_id, episode_number')
        .eq('id', episodeId)
        .eq('story_id', storyId)
        .eq('status', 'published')
        .is('deleted_at', null)
        .maybeSingle(),
    ])

    if (storyError) throw storyError
    if (episodeError) throw episodeError

    if (!story || !episode) {
      return res.status(404).json({
        ok: false,
        message: 'Story or episode was not found',
      })
    }

    const { count, error: countError } = await supabase
      .from('episodes')
      .select('id', { count: 'exact', head: true })
      .eq('story_id', storyId)
      .eq('status', 'published')
      .is('deleted_at', null)

    if (countError) throw countError

    const now = new Date().toISOString()
    const totalEpisodes = Math.max(
      1,
      Number(count || story.total_episodes || 1)
    )

    const { data, error } = await supabase
      .from('reading_progress')
      .upsert(
        {
          user_id: userId,
          story_id: storyId,
          episode_id: episodeId,
          episode_number: Math.max(1, Number(episode.episode_number || 1)),
          total_episodes: totalEpisodes,
          reading_percent: readingPercent,
          last_read_at: now,
          updated_at: now,
        },
        {
          onConflict: 'user_id,story_id',
        }
      )
      .select(
        'id, story_id, episode_id, episode_number, total_episodes, reading_percent, last_read_at'
      )
      .single()

    if (error) throw error

    return res.json({
      ok: true,
      progress: data,
    })
  } catch (error) {
    console.error('SAVE_READING_PROGRESS_ERROR', error)
    return res.status(500).json({
      ok: false,
      message: 'Failed to save reading progress',
    })
  }
}
