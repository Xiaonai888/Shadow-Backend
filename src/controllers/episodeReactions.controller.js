import { supabase } from '../config/supabase.js'
import { incrementAuthorPageAnalytics } from '../services/authorAnalytics.service.js'

function normalizeReactionType(value) {
  const reactionType = String(value || 'love').trim().toLowerCase()
  return reactionType === 'love' ? 'love' : 'love'
}

function getOptionalReader(req) {
  const user = req.user || null
  return user?.user_id ? user : null
}

async function getEpisode(episodeId) {
  const { data, error } = await supabase
    .from('episodes')
    .select('id, story_id, author_id, user_id, title, total_likes')
    .eq('id', episodeId)
    .maybeSingle()

  if (error) throw error
  return data
}

async function countEpisodeReactions(episodeId) {
  const { count, error } = await supabase
    .from('episode_reactions')
    .select('id', { count: 'exact', head: true })
    .eq('episode_id', episodeId)

  if (error) throw error
  return Number(count || 0)
}

async function syncEpisodeTotalLikes(episodeId) {
  const totalLikes = await countEpisodeReactions(episodeId)

  const { error } = await supabase
    .from('episodes')
    .update({
      total_likes: totalLikes,
      updated_at: new Date().toISOString(),
    })
    .eq('id', episodeId)

  if (error) throw error
  return totalLikes
}

export async function getEpisodeReactionStatus(req, res) {
  try {
    const episodeId = String(req.params.episodeId || '').trim()
    const user = getOptionalReader(req)
    const episode = await getEpisode(episodeId)

    if (!episode) {
      return res.status(404).json({
        ok: false,
        message: 'Episode not found',
      })
    }

    let myReaction = null

    if (user?.user_id) {
      const { data, error } = await supabase
        .from('episode_reactions')
        .select('id, reaction_type, created_at')
        .eq('episode_id', episodeId)
        .eq('user_id', user.user_id)
        .maybeSingle()

      if (error) throw error
      myReaction = data || null
    }

    const totalLikes = await syncEpisodeTotalLikes(episodeId)

    return res.status(200).json({
      ok: true,
      episode_id: episodeId,
      liked: Boolean(myReaction),
      reaction_type: myReaction?.reaction_type || null,
      total_likes: totalLikes,
    })
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: error.message || 'Failed to load episode reaction status',
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
    const episode = await getEpisode(episodeId)

    if (!episode) {
      return res.status(404).json({
        ok: false,
        message: 'Episode not found',
      })
    }

    const { data: countRows, error: countError } = await supabase
      .from('episode_reactions')
      .select('reaction_type')
      .eq('episode_id', episodeId)

    if (countError) throw countError

    const counts = (countRows || []).reduce((result, item) => {
      const type = String(item.reaction_type || 'love').toLowerCase()
      result[type] = Number(result[type] || 0) + 1
      return result
    }, {})

    const { data, error, count } = await supabase
      .from('episode_reactions')
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

export async function toggleEpisodeReaction(req, res) {
  try {
    const episodeId = String(req.params.episodeId || '').trim()
    const userId = req.user?.user_id
    const reactionType = normalizeReactionType(req.body?.reaction_type)

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Login is required',
      })
    }

    const episode = await getEpisode(episodeId)

    if (!episode) {
      return res.status(404).json({
        ok: false,
        message: 'Episode not found',
      })
    }

    const { data: existing, error: existingError } = await supabase
      .from('episode_reactions')
      .select('id, reaction_type')
      .eq('episode_id', episodeId)
      .eq('user_id', userId)
      .maybeSingle()

    if (existingError) throw existingError

    if (existing) {
      const { error: deleteError } = await supabase
        .from('episode_reactions')
        .delete()
        .eq('id', existing.id)

      if (deleteError) throw deleteError

      const totalLikes = await syncEpisodeTotalLikes(episodeId)

      return res.status(200).json({
        ok: true,
        action: 'removed',
        liked: false,
        reaction_type: null,
        total_likes: totalLikes,
      })
    }

    const { error: insertError } = await supabase
      .from('episode_reactions')
      .insert({
        user_id: userId,
        story_id: episode.story_id,
        episode_id: episodeId,
        reaction_type: reactionType,
      })

    if (insertError) throw insertError

    const totalLikes = await syncEpisodeTotalLikes(episodeId)
    const isOwner = String(episode.user_id || '') === String(userId)

    if (!isOwner && episode.author_id) {
      await incrementAuthorPageAnalytics(
        episode.author_id,
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
      message: error.message || 'Failed to update episode reaction',
    })
  }
}
