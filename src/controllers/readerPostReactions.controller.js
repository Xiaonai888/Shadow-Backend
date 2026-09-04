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

function buildReactionSummary(counts = {}) {
  return REACTION_ORDER
    .map((type, index) => ({
      type,
      count: Number(
        counts[type] || 0
      ),
      index,
    }))
    .filter((item) => item.count > 0)
    .sort((first, second) => {
      if (second.count !== first.count) {
        return second.count - first.count
      }

      return first.index - second.index
    })
    .slice(0, 3)
    .map(({ type, count }) => ({
      type,
      count,
    }))
}
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function isUuid(value) {
  return UUID_PATTERN.test(
    String(value || '').trim()
  )
}

async function resolveReaderPostId(value) {
  const rawId = String(value || '').trim()

  if (isUuid(rawId)) {
    return rawId
  }

  const syntheticMatch = rawId.match(
    /^(echo-v2|social-echo):(.+)$/i
  )

  if (!syntheticMatch) {
    return ''
  }

  const echoVersion =
    syntheticMatch[1].toLowerCase()
  const echoId =
    String(syntheticMatch[2] || '').trim()

  if (!isUuid(echoId)) {
    return ''
  }

  if (echoVersion === 'echo-v2') {
    const { data, error } = await supabase
      .from('social_echoes_v2')
      .select('source_type, source_id')
      .eq('id', echoId)
      .maybeSingle()

    if (error) throw error
    if (!data) return ''

    const sourceType = String(
      data.source_type || ''
    )
      .trim()
      .toLowerCase()
      .replaceAll('-', '_')

    const sourceId = String(
      data.source_id || ''
    ).trim()

    return (
      sourceType === 'reader_post' &&
      isUuid(sourceId)
    )
      ? sourceId
      : ''
  }

  const { data, error } = await supabase
    .from('social_echoes')
    .select(
      'source_type, source_id, reader_post_id'
    )
    .eq('id', echoId)
    .maybeSingle()

  if (error) throw error
  if (!data) return ''

  const linkedPostId = String(
    data.reader_post_id || ''
  ).trim()

  if (isUuid(linkedPostId)) {
    return linkedPostId
  }

  const sourceType = String(
    data.source_type || ''
  )
    .trim()
    .toLowerCase()
    .replaceAll('-', '_')

  const sourceId = String(
    data.source_id || ''
  ).trim()

  return (
    sourceType === 'reader_post' &&
    isUuid(sourceId)
  )
    ? sourceId
    : ''
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

async function readReactionStats(postId) {
  const results = await Promise.all(
    REACTION_ORDER.map(
      async (reactionType) => {
        const { count, error } =
          await supabase
            .from(
              'reader_post_reactions'
            )
            .select('id', {
              count: 'exact',
              head: true,
            })
            .eq('post_id', postId)
            .eq(
              'reaction_type',
              reactionType
            )

        if (error) throw error

        return [
          reactionType,
          Number(count || 0),
        ]
      }
    )
  )

  const counts = Object.fromEntries(
    results
  )
  const likeCount = results.reduce(
    (total, [, count]) =>
      total + Number(count || 0),
    0
  )

  return {
    counts,
    likeCount,
    summary:
      buildReactionSummary(counts),
  }
}

async function readMyReaction(
  postId,
  userId
) {
  if (!userId) return null

  const { data, error } = await supabase
    .from('reader_post_reactions')
    .select('reaction_type')
    .eq('post_id', postId)
    .eq('user_id', userId)
    .maybeSingle()

  if (error) throw error

  return data?.reaction_type || null
}

export async function getReaderPostReactionStatus(req, res) {
  try {
    const userId = getUserId(req)
    const rawPostId =
      String(req.params.postId || '').trim()
    const postId =
      await resolveReaderPostId(rawPostId)

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

    const [
      stats,
      myReaction,
    ] = await Promise.all([
      readReactionStats(postId),
      readMyReaction(postId, userId),
    ])

    return res.status(200).json({
      ok: true,
      my_reaction: myReaction,
      like_count: stats.likeCount,
      reaction_summary: stats.summary,
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
    const rawPostId =
      String(req.params.postId || '').trim()
    const postId =
      await resolveReaderPostId(rawPostId)
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

    const [
      stats,
      reactionResult,
    ] = await Promise.all([
      readReactionStats(postId),
      supabase
        .from('reader_post_reactions')
        .select(
          'id, user_id, reaction_type, created_at'
        )
        .eq('post_id', postId)
        .order('created_at', {
          ascending: false,
        })
        .range(from, to),
    ])

    if (reactionResult.error) {
      throw reactionResult.error
    }

    const counts = stats.counts

    const reactionRows = reactionResult.data || []
    const userIds = [
      ...new Set(
        reactionRows
          .map((item) => String(item.user_id || '').trim())
          .filter(Boolean)
      ),
    ]

    let usersById = new Map()

    if (userIds.length) {
      const { data: users, error: usersError } = await supabase
        .from('users')
        .select('id, name, username, avatar_url')
        .in('id', userIds)

      if (usersError) throw usersError

      usersById = new Map(
        (users || []).map((user) => [String(user.id), user])
      )
    }

    const reactions = reactionRows.map((item) => {
      const user = usersById.get(String(item.user_id || ''))

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

    const total = stats.likeCount

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
    const rawPostId =
      String(req.params.postId || '').trim()
    const postId =
      await resolveReaderPostId(rawPostId)
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

    const stats =
      await readReactionStats(postId)
    const likeCount = stats.likeCount
    const reactionSummary =
      stats.summary

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
