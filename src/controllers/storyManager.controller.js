import { supabase } from '../config/supabase.js'

const EARNINGS_PAGE_SIZE = 1000

function numberValue(value) {
  const number = Number(value || 0)
  return Number.isFinite(number) ? number : 0
}

function publicManagerEpisode(episode, commentCounts, earningTotals) {
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
    total_earnings_usd: numberValue(earningTotals.get(String(episode.id))),
    is_adult: Boolean(episode.is_adult),
    is_free_published: Boolean(episode.is_free_published),
    published_at: episode.published_at || null,
    scheduled_at: episode.scheduled_at || null,
    created_at: episode.created_at,
    updated_at: episode.updated_at,
  }
}

async function getEpisodeCommentCounts(storyId, episodeIds) {
  const counts = new Map()

  if (!episodeIds.length) return counts

  const { data, error } = await supabase
    .from('comments')
    .select('episode_id')
    .eq('story_id', storyId)
    .in('episode_id', episodeIds)
    .eq('is_hidden', false)
    .is('deleted_at', null)

  if (error) {
    console.error('GET STORY MANAGER COMMENT COUNTS ERROR:', error)
    return counts
  }

  for (const comment of data || []) {
    const key = String(comment.episode_id || '')
    if (!key) continue
    counts.set(key, Number(counts.get(key) || 0) + 1)
  }

  return counts
}

async function getEpisodeEarningTotals(userId, storyId, episodeIds) {
  const totals = new Map()

  if (!episodeIds.length) return totals

  let from = 0

  while (true) {
    const { data, error } = await supabase
      .from('author_earnings')
      .select('episode_id, author_net_payout_usd')
      .eq('author_user_id', userId)
      .eq('story_id', storyId)
      .eq('source_type', 'diamond_unlock')
      .eq('currency', 'diamond')
      .neq('earning_status', 'void')
      .in('episode_id', episodeIds)
      .range(from, from + EARNINGS_PAGE_SIZE - 1)

    if (error) {
      console.error('GET STORY MANAGER EARNINGS ERROR:', error)
      return totals
    }

    for (const earning of data || []) {
      const key = String(earning.episode_id || '')
      if (!key) continue
      totals.set(
        key,
        numberValue(totals.get(key)) +
          numberValue(earning.author_net_payout_usd)
      )
    }

    if (!data || data.length < EARNINGS_PAGE_SIZE) break
    from += EARNINGS_PAGE_SIZE
  }

  return totals
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
        'id, story_id, title, cover_url, status, episode_number, character_count, word_count, page_count, total_views, total_likes, is_adult, is_free_published, published_at, scheduled_at, created_at, updated_at'
      )
      .eq('story_id', storyId)
      .eq('user_id', userId)
      .is('deleted_at', null)
      .order('episode_number', { ascending: true })

    if (episodeError) throw episodeError

    const episodeIds = (episodes || []).map((episode) => episode.id).filter(Boolean)

    const [commentCounts, earningTotals] = await Promise.all([
      getEpisodeCommentCounts(storyId, episodeIds),
      getEpisodeEarningTotals(userId, storyId, episodeIds),
    ])

    return res.status(200).json({
      ok: true,
      story_type: story.story_type || 'novel',
      episodes: (episodes || []).map((episode) =>
        publicManagerEpisode(episode, commentCounts, earningTotals)
      ),
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
