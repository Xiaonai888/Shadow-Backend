import { supabase } from '../config/supabase.js'

function publicManagerEpisode(episode, commentCounts) {
  return {
    id: episode.id,
    story_id: episode.story_id,
    title: episode.title,
    cover_url: episode.cover_url || '',
    status: episode.status || 'draft',
    episode_number: Number(episode.episode_number || 0),
    character_count: Number(episode.character_count || 0),
    word_count: Number(episode.word_count || 0),
    page_count: Number(episode.page_count || 0),
    total_views: Number(episode.total_views || 0),
    total_likes: Number(episode.total_likes || 0),
    total_comments: Number(commentCounts.get(String(episode.id)) || 0),
    is_adult: Boolean(episode.is_adult),
    published_at: episode.published_at || null,
    scheduled_at: episode.scheduled_at || null,
    created_at: episode.created_at,
    updated_at: episode.updated_at,
  }
}

export async function getStoryManagerEpisodes(req, res) {
  try {
    const userId = req.user?.user_id
    const storyId = String(req.params.storyId || '').trim()

    if (!userId) {
      return res.status(401).json({ ok: false, message: 'Unauthorized' })
    }

    if (!storyId) {
      return res.status(400).json({ ok: false, message: 'Story ID is required' })
    }

    const { data: story, error: storyError } = await supabase
      .from('stories')
      .select('id, story_type')
      .eq('id', storyId)
      .eq('user_id', userId)
      .is('deleted_at', null)
      .maybeSingle()

    if (storyError) throw storyError

    if (!story) {
      return res.status(404).json({ ok: false, message: 'Story not found' })
    }

    const { data: episodes, error: episodeError } = await supabase
      .from('episodes')
      .select(
        'id, story_id, title, cover_url, status, episode_number, character_count, word_count, page_count, total_views, total_likes, is_adult, published_at, scheduled_at, created_at, updated_at'
      )
      .eq('story_id', storyId)
      .eq('user_id', userId)
      .is('deleted_at', null)
      .order('episode_number', { ascending: true })

    if (episodeError) throw episodeError

    const episodeIds = (episodes || []).map((episode) => episode.id).filter(Boolean)
    const commentCounts = new Map()

    if (episodeIds.length) {
      const { data: comments, error: commentError } = await supabase
        .from('comments')
        .select('episode_id')
        .eq('story_id', storyId)
        .in('episode_id', episodeIds)
        .eq('is_hidden', false)
        .is('deleted_at', null)

      if (!commentError) {
        for (const comment of comments || []) {
          const key = String(comment.episode_id || '')
          if (!key) continue
          commentCounts.set(key, Number(commentCounts.get(key) || 0) + 1)
        }
      }
    }

    return res.status(200).json({
      ok: true,
      story_type: story.story_type || 'novel',
      episodes: (episodes || []).map((episode) => publicManagerEpisode(episode, commentCounts)),
    })
  } catch (error) {
    console.error('GET STORY MANAGER EPISODES ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load story manager episodes',
      error: error.message,
    })
  }
}
