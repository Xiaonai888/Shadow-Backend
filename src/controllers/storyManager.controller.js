import { supabase } from '../config/supabase.js'

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

async function getEpisodeMetrics(storyId, userId, episodeIds) {
  const commentCounts = new Map()
  const earningTotals = new Map()

  if (!episodeIds.length) return { commentCounts, earningTotals }

  const { data, error } = await supabase.rpc('story_manager_episode_metrics_v1', {
    p_story_id: storyId,
    p_author_user_id: String(userId),
    p_episode_ids: episodeIds,
  })

  if (error) throw error
  if (!Array.isArray(data)) throw new Error('Invalid Story Manager metrics response')

  const returnedIds = new Set()

  for (const row of data) {
    const episodeId = String(row?.episode_id || '')
    if (!episodeId || returnedIds.has(episodeId)) {
      throw new Error('Invalid Story Manager episode metrics')
    }

    returnedIds.add(episodeId)
    commentCounts.set(episodeId, Number(row.total_comments || 0))
    earningTotals.set(episodeId, numberValue(row.total_earnings_usd))
  }

  if (episodeIds.some((episodeId) => !returnedIds.has(String(episodeId)))) {
    throw new Error('Incomplete Story Manager episode metrics')
  }

  return { commentCounts, earningTotals }
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

    const nowMs = Date.now()
const DAY_MS = 24 * 60 * 60 * 1000
const now = new Date(nowMs).toISOString()
const cutoff = new Date(nowMs - 30 * DAY_MS).toISOString()

const [activeResult, deletedResult] = await Promise.all([
  supabase
    .from('episodes')
    .select(
      'id, story_id, title, cover_url, status, episode_number, character_count, word_count, page_count, total_views, total_likes, is_adult, is_free_published, published_at, scheduled_at, created_at, updated_at'
    )
    .eq('story_id', storyId)
    .eq('user_id', userId)
    .is('deleted_at', null)
    .order('episode_number', { ascending: true }),

  supabase
    .from('episodes')
    .select(
      'id, story_id, title, status, episode_number, character_count, word_count, deleted_at, delete_expires_at'
    )
    .eq('story_id', storyId)
    .eq('user_id', userId)
    .not('deleted_at', 'is', null)
    .gte('deleted_at', cutoff)
    .gt('delete_expires_at', now)
    .order('deleted_at', { ascending: false }),
])

if (activeResult.error) throw activeResult.error
if (deletedResult.error) throw deletedResult.error

const episodes = activeResult.data || []

const deletedEpisodes = (deletedResult.data || [])
  .filter((episode) => {
    const deletedTime = Date.parse(episode.deleted_at)
    const expiryTime = Date.parse(episode.delete_expires_at)

    return (
      Number.isFinite(deletedTime) &&
      Number.isFinite(expiryTime) &&
      Math.min(expiryTime, deletedTime + 30 * DAY_MS) > nowMs
    )
  })
  .map((episode) => {
    const expiresAt = Math.min(
      Date.parse(episode.delete_expires_at),
      Date.parse(episode.deleted_at) + 30 * DAY_MS
    )

    return {
      ...episode,
      days_left: Math.max(
        0,
        Math.ceil((expiresAt - nowMs) / DAY_MS)
      ),
    }
  })

    const episodeIds = (episodes || []).map((episode) => episode.id).filter(Boolean)
    const { commentCounts, earningTotals } = await getEpisodeMetrics(storyId, userId, episodeIds)

    return res.status(200).json({
  ok: true,
  story_type: story.story_type || 'novel',

  episodes: episodes.map((episode) =>
    publicManagerEpisode(episode, commentCounts, earningTotals)
  ),

  deleted_episodes: deletedEpisodes,
  deleted_count: deletedEpisodes.length,
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
