import { supabase } from '../config/supabase.js'
import { incrementAuthorPageAnalytics } from '../services/authorAnalytics.service.js'

function normalizeReactionType(value) {
  const reactionType = String(value || 'love').trim().toLowerCase()

  if (reactionType === 'love') return 'love'

  return 'love'
}

function getOptionalReader(req) {
  try {
    const user = req.user || null

    if (!user?.user_id) return null

    return user
  } catch {
    return null
  }
}

async function getStory(storyId) {
  const { data, error } = await supabase
    .from('stories')
    .select('id, author_id, user_id, total_likes')
    .eq('id', storyId)
    .maybeSingle()

  if (error) throw error

  return data
}

async function countStoryReactions(storyId) {
  const { count, error } = await supabase
    .from('story_reactions')
    .select('id', { count: 'exact', head: true })
    .eq('story_id', storyId)

  if (error) throw error

  return Number(count || 0)
}

async function syncStoryTotalLikes(storyId) {
  const totalLikes = await countStoryReactions(storyId)

  const { error } = await supabase
    .from('stories')
    .update({
      total_likes: totalLikes,
      updated_at: new Date().toISOString(),
    })
    .eq('id', storyId)

  if (error) throw error

  return totalLikes
}

export async function getStoryReactionStatus(req, res) {
  try {
    const storyId = req.params.storyId
    const user = getOptionalReader(req)
    const story = await getStory(storyId)

    if (!story) {
      return res.status(404).json({
        ok: false,
        message: 'Story not found',
      })
    }

    let myReaction = null

    if (user?.user_id) {
      const { data, error } = await supabase
        .from('story_reactions')
        .select('id, reaction_type, created_at')
        .eq('story_id', storyId)
        .eq('user_id', user.user_id)
        .maybeSingle()

      if (error) throw error
      myReaction = data || null
    }

    const totalLikes = await syncStoryTotalLikes(storyId)

    return res.status(200).json({
      ok: true,
      story_id: storyId,
      liked: Boolean(myReaction),
      reaction_type: myReaction?.reaction_type || null,
      total_likes: totalLikes,
    })
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: error.message || 'Failed to load reaction status',
    })
  }
}

export async function getEpisodeReactions(req, res) {
  try {
    const episodeId = String(req.params.episodeId || '').trim()
    const page = Math.max(1, Number(req.query.page || 1))
    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 100)))
    const from = (page - 1) * limit
    const to = from + limit - 1

    const { data: episode, error: episodeError } = await supabase
      .from('episodes')
      .select('id, story_id, title')
      .eq('id', episodeId)
      .maybeSingle()

    if (episodeError) throw episodeError

    if (!episode) {
      return res.status(404).json({
        ok: false,
        message: 'Episode not found',
      })
    }

    const { data: countRows, error: countError } = await supabase
      .from('story_reactions')
      .select('reaction_type')
      .eq('episode_id', episodeId)

    if (countError) throw countError

    const counts = (countRows || []).reduce((result, item) => {
      const type = String(item.reaction_type || 'love').toLowerCase()
      result[type] = Number(result[type] || 0) + 1
      return result
    }, {})

    const { data, error, count } = await supabase
      .from('story_reactions')
      .select(
        'id, user_id, reaction_type, created_at, user:users(id, name, username, avatar_url)',
        { count: 'exact' }
      )
      .eq('episode_id', episodeId)
      .order('created_at', { ascending: false })
      .range(from, to)

    if (error) throw error

    const reactions = (data || []).map((item) => {
      const user = Array.isArray(item.user) ? item.user[0] : item.user

      return {
        id: item.id,
        reaction_type: item.reaction_type || 'love',
        created_at: item.created_at,
        user: {
          id: user?.id || item.user_id,
          name: user?.name || user?.username || 'Reader',
          username: user?.username || '',
          avatar_url: user?.avatar_url || '',
        },
      }
    })

    const total = Number(count || 0)

    return res.status(200).json({
      ok: true,
      episode: {
        id: episode.id,
        story_id: episode.story_id,
        title: episode.title || '',
      },
      total,
      counts,
      page,
      limit,
      has_more: to + 1 < total,
      reactions,
    })
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: error.message || 'Failed to load episode reactions',
    })
  }
}

export async function toggleStoryReaction(req, res) {
  try {
    const storyId = req.params.storyId
    const userId = req.user?.user_id
    const reactionType = normalizeReactionType(req.body?.reaction_type)
    const episodeId = req.body?.episode_id || null

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Login is required',
      })
    }

    const story = await getStory(storyId)

    if (!story) {
      return res.status(404).json({
        ok: false,
        message: 'Story not found',
      })
    }

    const { data: existing, error: existingError } = await supabase
      .from('story_reactions')
      .select('id, reaction_type')
      .eq('story_id', storyId)
      .eq('user_id', userId)
      .maybeSingle()

    if (existingError) throw existingError

    if (existing) {
      const { error: deleteError } = await supabase
        .from('story_reactions')
        .delete()
        .eq('id', existing.id)

      if (deleteError) throw deleteError

      const totalLikes = await syncStoryTotalLikes(storyId)

      return res.status(200).json({
        ok: true,
        action: 'removed',
        liked: false,
        reaction_type: null,
        total_likes: totalLikes,
      })
    }

    const { error: insertError } = await supabase
      .from('story_reactions')
      .insert({
        user_id: userId,
        story_id: storyId,
        episode_id: episodeId,
        reaction_type: reactionType,
      })

    if (insertError) throw insertError

    const totalLikes = await syncStoryTotalLikes(storyId)

    const isOwner =
      String(story.user_id || '') === String(userId)

    if (!isOwner && story.author_id) {
      await incrementAuthorPageAnalytics(
        story.author_id,
        'interactions'
      )
    }

    return res.status(200).json({
      ok: true,
      action: 'added',
      liked: true,
      reaction_type: reactionType,
      total_likes: totalLikes,
    })
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: error.message || 'Failed to update reaction',
    })
  }
}
