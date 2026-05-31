import { supabase } from '../config/supabase.js'

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
    .select('id, total_likes')
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
