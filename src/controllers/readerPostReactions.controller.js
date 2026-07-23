import { supabase } from '../config/supabase.js'

const ALLOWED_REACTIONS = new Set([
  'love',
  'haha',
  'wow',
  'sad',
  'angry',
  'support',
  'touched',
])

const REACTION_ORDER = [
  'love',
  'haha',
  'wow',
  'sad',
  'angry',
  'support',
  'touched',
]

function getUserId(req) {
  return String(req.user?.user_id || req.user?.id || '').trim()
}

function normalizeReactionType(value) {
  return String(value || 'love').trim().toLowerCase()
}

function buildReactionSummary(rows = []) {
  const rank = new Map(REACTION_ORDER.map((type, index) => [type, index]))
  const counts = new Map()

  for (const row of rows) {
    const type = normalizeReactionType(row?.reaction_type)

    if (!ALLOWED_REACTIONS.has(type)) continue

    counts.set(type, Number(counts.get(type) || 0) + 1)
  }

  return [...counts.entries()]
    .map(([type, count]) => ({ type, count }))
    .sort((first, second) => {
      if (second.count !== first.count) return second.count - first.count
      return Number(rank.get(first.type) ?? 99) - Number(rank.get(second.type) ?? 99)
    })
    .slice(0, 3)
}

async function readReaderPost(postId) {
  const { data, error } = await supabase
    .from('reader_posts')
    .select('id, user_id, like_count, deleted_at')
    .eq('id', postId)
    .is('deleted_at', null)
    .maybeSingle()

  if (error) throw error

  return data
}

async function readReactionRows(postId) {
  const { data, error } = await supabase
    .from('reader_post_reactions')
    .select('user_id, reaction_type')
    .eq('post_id', postId)

  if (error) throw error

  return data || []
}

export async function getReaderPostReactionStatus(req, res) {
  try {
    const userId = getUserId(req)
    const postId = String(req.params.postId || '').trim()

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    if (!postId) {
      return res.status(400).json({
        ok: false,
        message: 'Post ID is required',
      })
    }

    const post = await readReaderPost(postId)

    if (!post) {
      return res.status(404).json({
        ok: false,
        message: 'Post not found',
      })
    }

    const rows = await readReactionRows(postId)
    const myReaction =
      rows.find((row) => String(row.user_id || '') === userId)?.reaction_type || null

    return res.status(200).json({
      ok: true,
      my_reaction: myReaction,
      like_count: rows.length,
      reaction_summary: buildReactionSummary(rows),
    })
  } catch (error) {
    console.error('GET READER POST REACTION STATUS ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load post reaction',
      error: error.message,
    })
  }
}

export async function getReaderPostReactions(req, res) {
  try {
    const postId = String(req.params.postId || '').trim()
    const page = Math.max(1, Number(req.query.page || 1))
    const limit = Math.min(100, Math.max(1, Number(req.query.limit || 50)))
    const from = (page - 1) * limit
    const to = from + limit - 1

    if (!postId) {
      return res.status(400).json({
        ok: false,
        message: 'Post ID is required',
      })
    }

    const post = await readReaderPost(postId)

    if (!post) {
      return res.status(404).json({
        ok: false,
        message: 'Post not found',
      })
    }

    const { data: countRows, error: countError } = await supabase
      .from('reader_post_reactions')
      .select('reaction_type')
      .eq('post_id', postId)

    if (countError) throw countError

    const counts = (countRows || []).reduce((result, item) => {
      const type = normalizeReactionType(item.reaction_type)

      if (!ALLOWED_REACTIONS.has(type)) return result

      result[type] = Number(result[type] || 0) + 1
      return result
    }, {})

    const { data, error, count } = await supabase
      .from('reader_post_reactions')
      .select(
        'id, user_id, reaction_type, created_at, user:users(id, name, username, avatar_url)',
        { count: 'exact' }
      )
      .eq('post_id', postId)
      .order('created_at', { ascending: false })
      .range(from, to)

    if (error) throw error

    const reactions = (data || []).map((item) => {
      const user = Array.isArray(item.user) ? item.user[0] : item.user

      return {
        id: item.id,
        reaction_type: normalizeReactionType(item.reaction_type),
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
      post: {
        id: post.id,
      },
      total,
      counts,
      page,
      limit,
      has_more: to + 1 < total,
      reactions,
    })
  } catch (error) {
    console.error('GET READER POST REACTIONS ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load post reactions',
      error: error.message,
    })
  }
}


export async function setReaderPostReaction(req, res) {
  try {
    const userId = getUserId(req)
    const postId = String(req.params.postId || '').trim()
    const reactionType = normalizeReactionType(
      req.body?.reaction_type || req.body?.reactionType
    )

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    if (!postId) {
      return res.status(400).json({
        ok: false,
        message: 'Post ID is required',
      })
    }

    if (!ALLOWED_REACTIONS.has(reactionType)) {
      return res.status(400).json({
        ok: false,
        message: 'Invalid reaction type',
      })
    }

    const post = await readReaderPost(postId)

    if (!post) {
      return res.status(404).json({
        ok: false,
        message: 'Post not found',
      })
    }

    const { data: existingReaction, error: existingError } = await supabase
      .from('reader_post_reactions')
      .select('id, reaction_type')
      .eq('post_id', postId)
      .eq('user_id', userId)
      .maybeSingle()

    if (existingError) throw existingError

    let reacted = true
    let nextReactionType = reactionType

    if (existingReaction?.reaction_type === reactionType) {
      const { error: deleteError } = await supabase
        .from('reader_post_reactions')
        .delete()
        .eq('id', existingReaction.id)

      if (deleteError) throw deleteError

      reacted = false
      nextReactionType = null
    } else if (existingReaction?.id) {
      const { error: updateError } = await supabase
        .from('reader_post_reactions')
        .update({
          reaction_type: reactionType,
          updated_at: new Date().toISOString(),
        })
        .eq('id', existingReaction.id)

      if (updateError) throw updateError
    } else {
      const { error: insertError } = await supabase
        .from('reader_post_reactions')
        .insert({
          post_id: postId,
          user_id: userId,
          reaction_type: reactionType,
        })

      if (insertError) throw insertError
    }

    const rows = await readReactionRows(postId)
    const likeCount = rows.length
    const reactionSummary = buildReactionSummary(rows)

    const { error: updatePostError } = await supabase
      .from('reader_posts')
      .update({
        like_count: likeCount,
        updated_at: new Date().toISOString(),
      })
      .eq('id', postId)
      .is('deleted_at', null)

    if (updatePostError) throw updatePostError

    return res.status(200).json({
      ok: true,
      reacted,
      reaction_type: nextReactionType,
      like_count: likeCount,
      reaction_summary: reactionSummary,
      post: {
        id: postId,
        like_count: likeCount,
        my_reaction: nextReactionType,
        reaction_summary: reactionSummary,
      },
    })
  } catch (error) {
    console.error('SET READER POST REACTION ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to update post reaction',
      error: error.message,
    })
  }
}
