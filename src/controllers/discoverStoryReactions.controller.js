import { supabase } from '../config/supabase.js'

const REACTION_TYPES = Object.freeze([
  'love',
  'haha',
  'wow',
  'sad',
  'angry',
  'support',
  'touched',
])

const REACTION_TYPE_SET =
  new Set(REACTION_TYPES)

function normalizeSourceType(value) {
  const sourceType = String(
    value || ''
  )
    .trim()
    .toLowerCase()

  return ['reader', 'author'].includes(
    sourceType
  )
    ? sourceType
    : ''
}

function normalizeReactionType(value) {
  const reactionType = String(
    value || ''
  )
    .trim()
    .toLowerCase()

  return REACTION_TYPE_SET.has(
    reactionType
  )
    ? reactionType
    : ''
}

async function getActiveStory(
  sourceType,
  storyId
) {
  const now = new Date().toISOString()
  const table =
    sourceType === 'author'
      ? 'author_page_stories'
      : 'reader_stories'
  const fields =
    sourceType === 'author'
      ? 'id, user_id, author_page_id, status, expires_at'
      : 'id, user_id, status, expires_at'

  const { data, error } = await supabase
    .from(table)
    .select(fields)
    .eq('id', storyId)
    .eq('status', 'active')
    .gt('expires_at', now)
    .maybeSingle()

  if (error) throw error

  return data || null
}

async function canViewStory(
  sourceType,
  story,
  userId
) {
  if (
    String(story.user_id) ===
    String(userId)
  ) {
    return true
  }

  if (sourceType === 'author') {
    const {
      data,
      error,
    } = await supabase
      .from('author_page_follows')
      .select('author_page_id')
      .eq(
        'follower_user_id',
        userId
      )
      .eq(
        'author_page_id',
        story.author_page_id
      )
      .maybeSingle()

    if (error) throw error
    return Boolean(data)
  }

  const {
    data,
    error,
  } = await supabase
    .from('user_follows')
    .select('following_user_id')
    .eq(
      'follower_user_id',
      userId
    )
    .eq(
      'following_user_id',
      story.user_id
    )
    .maybeSingle()

  if (error) throw error
  return Boolean(data)
}

async function getReactionCounts(
  sourceType,
  storyId
) {
  const results = await Promise.all(
    REACTION_TYPES.map(
      async (reactionType) => {
        const {
          count,
          error,
        } = await supabase
          .from(
            'discover_story_reactions'
          )
          .select('id', {
            count: 'exact',
            head: true,
          })
          .eq(
            'source_type',
            sourceType
          )
          .eq(
            'story_id',
            storyId
          )
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

  const counts =
    Object.fromEntries(results)
  const total =
    Object.values(counts).reduce(
      (sum, value) =>
        sum + Number(value || 0),
      0
    )

  return {
    counts,
    total,
  }
}

async function getExistingReaction(
  sourceType,
  storyId,
  userId
) {
  const { data, error } = await supabase
    .from('discover_story_reactions')
    .select('id, reaction_type')
    .eq('source_type', sourceType)
    .eq('story_id', storyId)
    .eq('user_id', userId)
    .maybeSingle()

  if (error) throw error

  return data || null
}

async function resolveStoryAccess(
  req,
  res
) {
  const userId = req.user?.user_id
  const sourceType =
    normalizeSourceType(
      req.params.sourceType
    )
  const storyId = String(
    req.params.storyId || ''
  ).trim()

  if (!userId) {
    res.status(401).json({
      ok: false,
      message: 'Unauthorized',
    })
    return null
  }

  if (!sourceType || !storyId) {
    res.status(400).json({
      ok: false,
      message:
        'Valid story source and ID are required',
    })
    return null
  }

  const story = await getActiveStory(
    sourceType,
    storyId
  )

  if (!story) {
    res.status(404).json({
      ok: false,
      message:
        'Story not found or expired',
    })
    return null
  }

  const allowed = await canViewStory(
    sourceType,
    story,
    userId
  )

  if (!allowed) {
    res.status(403).json({
      ok: false,
      message:
        'You cannot access this story',
    })
    return null
  }

  return {
    userId,
    sourceType,
    storyId,
    story,
  }
}

export async function getDiscoverStoryReactionStatus(
  req,
  res
) {
  try {
    const access =
      await resolveStoryAccess(
        req,
        res
      )

    if (!access) return

    const {
      userId,
      sourceType,
      storyId,
    } = access

    const [
      existing,
      summary,
    ] = await Promise.all([
      getExistingReaction(
        sourceType,
        storyId,
        userId
      ),
      getReactionCounts(
        sourceType,
        storyId
      ),
    ])

    res.set(
      'Cache-Control',
      'private, no-store'
    )

    return res.status(200).json({
      ok: true,
      source_type: sourceType,
      story_id: storyId,
      reaction_type:
        existing?.reaction_type || null,
      counts: summary.counts,
      total: summary.total,
    })
  } catch (error) {
    console.error(
      'GET DISCOVER STORY REACTION ERROR:',
      error
    )

    return res.status(500).json({
      ok: false,
      message:
        'Failed to load story reaction',
    })
  }
}

export async function toggleDiscoverStoryReaction(
  req,
  res
) {
  try {
    const access =
      await resolveStoryAccess(
        req,
        res
      )

    if (!access) return

    const {
      userId,
      sourceType,
      storyId,
      story,
    } = access

    if (
      String(story.user_id) ===
      String(userId)
    ) {
      return res.status(403).json({
        ok: false,
        message:
          'Owners cannot react to their own story',
      })
    }

    const reactionType =
      normalizeReactionType(
        req.body?.reaction_type
      )

    if (!reactionType) {
      return res.status(400).json({
        ok: false,
        message:
          'Invalid reaction type',
      })
    }

    const existing =
      await getExistingReaction(
        sourceType,
        storyId,
        userId
      )

    let action = 'added'
    let nextReactionType =
      reactionType

    if (
      existing?.reaction_type ===
      reactionType
    ) {
      const { error } = await supabase
        .from(
          'discover_story_reactions'
        )
        .delete()
        .eq('id', existing.id)

      if (error) throw error

      action = 'removed'
      nextReactionType = null
    } else if (existing) {
      const { error } = await supabase
        .from(
          'discover_story_reactions'
        )
        .update({
          reaction_type:
            reactionType,
          updated_at:
            new Date().toISOString(),
        })
        .eq('id', existing.id)

      if (error) throw error

      action = 'updated'
    } else {
      const { error } = await supabase
        .from(
          'discover_story_reactions'
        )
        .insert({
          source_type: sourceType,
          story_id: storyId,
          user_id: userId,
          reaction_type:
            reactionType,
        })

      if (
        error &&
        error.code !== '23505'
      ) {
        throw error
      }

      if (error?.code === '23505') {
        const {
          error: updateError,
        } = await supabase
          .from(
            'discover_story_reactions'
          )
          .update({
            reaction_type:
              reactionType,
            updated_at:
              new Date().toISOString(),
          })
          .eq(
            'source_type',
            sourceType
          )
          .eq(
            'story_id',
            storyId
          )
          .eq(
            'user_id',
            userId
          )

        if (updateError) {
          throw updateError
        }

        action = 'updated'
      }
    }

    const summary =
      await getReactionCounts(
        sourceType,
        storyId
      )

    res.set(
      'Cache-Control',
      'private, no-store'
    )

    return res.status(200).json({
      ok: true,
      action,
      source_type: sourceType,
      story_id: storyId,
      reaction_type:
        nextReactionType,
      counts: summary.counts,
      total: summary.total,
    })
  } catch (error) {
    console.error(
      'TOGGLE DISCOVER STORY REACTION ERROR:',
      error
    )

    return res.status(500).json({
      ok: false,
      message:
        'Failed to update story reaction',
    })
  }
}
