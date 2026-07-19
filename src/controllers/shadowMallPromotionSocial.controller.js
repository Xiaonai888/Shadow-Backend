import { supabase } from '../config/supabase.js'

const COMMENT_LIMIT = 1000
const DEFAULT_PAGE_SIZE = 20
const MAX_PAGE_SIZE = 30

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

const DESTINATIONS = new Set([
  'feed',
  'shadow',
  'reader',
  'circle',
])

const AUDIENCES = new Set([
  'public',
  'followers',
  'close-readers',
  'only-me',
])

function getUserId(req) {
  return String(
    req.user?.user_id ||
      req.user?.id ||
      ''
  ).trim()
}

function getPromotionId(value) {
  const id = Number(value)

  if (!Number.isInteger(id) || id <= 0) {
    return null
  }

  return id
}

function normalizeReactionType(value) {
  return String(value || 'love')
    .trim()
    .toLowerCase()
}

function normalizeText(value) {
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .trim()
}

function cleanText(value, maxLength = 280) {
  return String(value || '')
    .trim()
    .slice(0, maxLength)
}

function normalizeChoice(
  value,
  allowed,
  fallback
) {
  const choice = String(
    value || fallback
  )
    .trim()
    .toLowerCase()

  return allowed.has(choice)
    ? choice
    : fallback
}

function getPagination(req) {
  const page = Math.max(
    1,
    Number.parseInt(req.query.page, 10) || 1
  )
  const limit = Math.min(
    MAX_PAGE_SIZE,
    Math.max(
      1,
      Number.parseInt(req.query.limit, 10) ||
        DEFAULT_PAGE_SIZE
    )
  )

  return {
    page,
    limit,
    from: (page - 1) * limit,
    to: page * limit - 1,
  }
}

function buildReactionSummary(rows = []) {
  const rank = new Map(
    REACTION_ORDER.map(
      (type, index) => [type, index]
    )
  )
  const counts = new Map()

  for (const row of rows) {
    const type = normalizeReactionType(
      row?.reaction_type
    )

    if (!ALLOWED_REACTIONS.has(type)) {
      continue
    }

    counts.set(
      type,
      Number(counts.get(type) || 0) + 1
    )
  }

  return [...counts.entries()]
    .map(([type, count]) => ({
      type,
      count,
    }))
    .sort((first, second) => {
      if (second.count !== first.count) {
        return second.count - first.count
      }

      return (
        Number(rank.get(first.type) ?? 99) -
        Number(rank.get(second.type) ?? 99)
      )
    })
    .slice(0, 3)
}

function publicUser(user, fallbackId = null) {
  const row = Array.isArray(user)
    ? user[0]
    : user

  return {
    id: row?.id || fallbackId,
    name:
      row?.name ||
      row?.username ||
      'Reader',
    username: row?.username || '',
    avatar_url: row?.avatar_url || '',
  }
}

function publicComment(
  comment,
  likedIds = new Set()
) {
  if (!comment) return null

  const user = Array.isArray(comment.user)
    ? comment.user[0]
    : comment.user

  return {
    id: comment.id,
    promotion_id: comment.promotion_id,
    post_id: String(
      comment.promotion_id || ''
    ),
    user_id: comment.user_id,
    parent_id: comment.parent_id || null,
    text: comment.text || '',
    likes: Number(comment.likes || 0),
    liked: likedIds.has(
      String(comment.id)
    ),
    is_hidden: Boolean(
      comment.is_hidden
    ),
    created_at: comment.created_at,
    updated_at: comment.updated_at,
    user: user
      ? {
          id: user.id,
          name:
            user.name ||
            user.username ||
            'Reader',
          username:
            user.username || '',
          avatar_url:
            user.avatar_url || '',
          role: user.role || 'reader',
        }
      : {
          id: comment.user_id,
          name: 'Reader',
          username: '',
          avatar_url: '',
          role: 'reader',
        },
    replies: Array.isArray(
      comment.replies
    )
      ? comment.replies.map((reply) =>
          publicComment(reply, likedIds)
        )
      : [],
  }
}

function publicEcho(item) {
  return {
    id: item.id,
    promotion_id: item.promotion_id,
    post_id: String(
      item.promotion_id || ''
    ),
    user_id: item.user_id,
    echo_text: item.echo_text || '',
    destination:
      item.destination || 'feed',
    audience: item.audience || 'public',
    created_at: item.created_at,
    user: publicUser(
      item.user,
      item.user_id
    ),
  }
}

async function readPromotion(
  promotionId,
  activeOnly = true
) {
  let query = supabase
    .from('shadow_mall_ads')
    .select(
      'id, sponsor, title, description, profile_image_url, is_active, like_count, comment_count, echo_count'
    )
    .eq('id', promotionId)

  if (activeOnly) {
    query = query.eq('is_active', true)
  }

  const { data, error } =
    await query.maybeSingle()

  if (error) throw error

  return data
}

async function readUser(userId) {
  const { data, error } = await supabase
    .from('users')
    .select(
      'id, name, username, avatar_url, is_active'
    )
    .eq('id', userId)
    .maybeSingle()

  if (error) throw error

  if (
    !data ||
    data.is_active === false
  ) {
    return null
  }

  return data
}

async function readReactionRows(
  promotionId
) {
  const { data, error } = await supabase
    .from(
      'shadow_mall_promotion_reactions'
    )
    .select('user_id, reaction_type')
    .eq('promotion_id', promotionId)

  if (error) throw error

  return data || []
}

async function updatePromotionLikeCount(
  promotionId,
  likeCount
) {
  const { error } = await supabase
    .from('shadow_mall_ads')
    .update({
      like_count: Number(
        likeCount || 0
      ),
    })
    .eq('id', promotionId)

  if (error) throw error
}

async function countVisibleComments(
  promotionId
) {
  const { count, error } = await supabase
    .from(
      'shadow_mall_promotion_comments'
    )
    .select('id', {
      count: 'exact',
      head: true,
    })
    .eq('promotion_id', promotionId)
    .eq('is_hidden', false)

  if (error) throw error

  return Number(count || 0)
}

async function updatePromotionCommentCount(
  promotionId,
  commentCount
) {
  const { error } = await supabase
    .from('shadow_mall_ads')
    .update({
      comment_count: Number(
        commentCount || 0
      ),
    })
    .eq('id', promotionId)

  if (error) throw error
}

async function readLikedCommentIds(
  userId,
  commentIds
) {
  if (
    !userId ||
    !commentIds.length
  ) {
    return new Set()
  }

  const { data, error } = await supabase
    .from(
      'shadow_mall_promotion_comment_likes'
    )
    .select('comment_id')
    .eq('user_id', userId)
    .in('comment_id', commentIds)

  if (error) throw error

  return new Set(
    (data || []).map((item) =>
      String(item.comment_id)
    )
  )
}

async function readEchoCount(
  promotionId
) {
  const { count, error } = await supabase
    .from(
      'shadow_mall_promotion_echoes'
    )
    .select('id', {
      count: 'exact',
      head: true,
    })
    .eq('promotion_id', promotionId)

  if (error) throw error

  return Number(count || 0)
}

async function updatePromotionEchoCount(
  promotionId,
  echoCount
) {
  const { error } = await supabase
    .from('shadow_mall_ads')
    .update({
      echo_count: Number(
        echoCount || 0
      ),
    })
    .eq('id', promotionId)

  if (error) throw error
}

export async function getShadowMallPromotionReactionStatus(
  req,
  res
) {
  try {
    const userId = getUserId(req)
    const promotionId = getPromotionId(
      req.params.promotionId
    )

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    if (!promotionId) {
      return res.status(400).json({
        ok: false,
        message:
          'Promotion ID is required',
      })
    }

    const promotion =
      await readPromotion(promotionId)

    if (!promotion) {
      return res.status(404).json({
        ok: false,
        message:
          'Shadow Mall promotion not found',
      })
    }

    const rows =
      await readReactionRows(
        promotionId
      )
    const myReaction =
      rows.find(
        (row) =>
          String(row.user_id || '') ===
          userId
      )?.reaction_type || null

    return res.status(200).json({
      ok: true,
      my_reaction: myReaction,
      like_count: rows.length,
      reaction_summary:
        buildReactionSummary(rows),
    })
  } catch (error) {
    console.error(
      'GET SHADOW MALL PROMOTION REACTION STATUS ERROR:',
      error
    )

    return res.status(500).json({
      ok: false,
      message:
        'Failed to load promotion reaction',
      error: error.message,
    })
  }
}

export async function setShadowMallPromotionReaction(
  req,
  res
) {
  try {
    const userId = getUserId(req)
    const promotionId = getPromotionId(
      req.params.promotionId
    )
    const reactionType =
      normalizeReactionType(
        req.body?.reaction_type ||
          req.body?.reactionType
      )

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    if (!promotionId) {
      return res.status(400).json({
        ok: false,
        message:
          'Promotion ID is required',
      })
    }

    if (
      !ALLOWED_REACTIONS.has(
        reactionType
      )
    ) {
      return res.status(400).json({
        ok: false,
        message:
          'Invalid reaction type',
      })
    }

    const promotion =
      await readPromotion(promotionId)

    if (!promotion) {
      return res.status(404).json({
        ok: false,
        message:
          'Shadow Mall promotion not found',
      })
    }

    const {
      data: existingReaction,
      error: existingError,
    } = await supabase
      .from(
        'shadow_mall_promotion_reactions'
      )
      .select('id, reaction_type')
      .eq(
        'promotion_id',
        promotionId
      )
      .eq('user_id', userId)
      .maybeSingle()

    if (existingError) {
      throw existingError
    }

    let reacted = true
    let nextReactionType =
      reactionType

    if (
      existingReaction?.reaction_type ===
      reactionType
    ) {
      const { error: deleteError } =
        await supabase
          .from(
            'shadow_mall_promotion_reactions'
          )
          .delete()
          .eq('id', existingReaction.id)

      if (deleteError) {
        throw deleteError
      }

      reacted = false
      nextReactionType = null
    } else if (
      existingReaction?.id
    ) {
      const { error: updateError } =
        await supabase
          .from(
            'shadow_mall_promotion_reactions'
          )
          .update({
            reaction_type:
              reactionType,
            updated_at:
              new Date().toISOString(),
          })
          .eq('id', existingReaction.id)

      if (updateError) {
        throw updateError
      }
    } else {
      const { error: insertError } =
        await supabase
          .from(
            'shadow_mall_promotion_reactions'
          )
          .insert({
            promotion_id:
              promotionId,
            user_id: userId,
            reaction_type:
              reactionType,
          })

      if (insertError) {
        throw insertError
      }
    }

    const rows =
      await readReactionRows(
        promotionId
      )
    const likeCount = rows.length
    const reactionSummary =
      buildReactionSummary(rows)

    await updatePromotionLikeCount(
      promotionId,
      likeCount
    )

    return res.status(200).json({
      ok: true,
      reacted,
      reaction_type:
        nextReactionType,
      like_count: likeCount,
      reaction_summary:
        reactionSummary,
      promotion: {
        id: promotionId,
        like_count: likeCount,
        my_reaction:
          nextReactionType,
        reaction_summary:
          reactionSummary,
      },
      post: {
        id: promotionId,
        like_count: likeCount,
        my_reaction:
          nextReactionType,
        reaction_summary:
          reactionSummary,
      },
    })
  } catch (error) {
    console.error(
      'SET SHADOW MALL PROMOTION REACTION ERROR:',
      error
    )

    return res.status(500).json({
      ok: false,
      message:
        'Failed to update promotion reaction',
      error: error.message,
    })
  }
}

export async function getShadowMallPromotionComments(
  req,
  res
) {
  try {
    const userId = getUserId(req)
    const promotionId = getPromotionId(
      req.params.promotionId
    )
    const sort = String(
      req.query.sort || 'top'
    )
      .trim()
      .toLowerCase()
    const {
      page,
      limit,
      from,
      to,
    } = getPagination(req)

    if (!promotionId) {
      return res.status(400).json({
        ok: false,
        message:
          'Promotion ID is required',
      })
    }

    const promotion =
      await readPromotion(promotionId)

    if (!promotion) {
      return res.status(404).json({
        ok: false,
        message:
          'Shadow Mall promotion not found',
      })
    }

    let parentQuery = supabase
      .from(
        'shadow_mall_promotion_comments'
      )
      .select(
        '*, user:users(id, name, username, avatar_url, role)'
      )
      .eq(
        'promotion_id',
        promotionId
      )
      .eq('is_hidden', false)
      .is('parent_id', null)

    if (sort === 'top') {
      parentQuery = parentQuery
        .order('likes', {
          ascending: false,
        })
        .order('created_at', {
          ascending: false,
        })
    } else {
      parentQuery =
        parentQuery.order(
          'created_at',
          {
            ascending: false,
          }
        )
    }

    const {
      data: parentComments,
      error: parentError,
    } = await parentQuery.range(
      from,
      to
    )

    if (parentError) {
      throw parentError
    }

    const parentIds = (
      parentComments || []
    )
      .map((comment) => comment.id)
      .filter(Boolean)

    let replies = []

    if (parentIds.length) {
      const { data, error } =
        await supabase
          .from(
            'shadow_mall_promotion_comments'
          )
          .select(
            '*, user:users(id, name, username, avatar_url, role)'
          )
          .eq(
            'promotion_id',
            promotionId
          )
          .eq('is_hidden', false)
          .in('parent_id', parentIds)
          .order('created_at', {
            ascending: true,
          })

      if (error) throw error

      replies = data || []
    }

    const repliesByParent =
      new Map()

    for (const reply of replies) {
      const key = String(
        reply.parent_id || ''
      )
      const current =
        repliesByParent.get(key) || []

      current.push(reply)
      repliesByParent.set(
        key,
        current
      )
    }

    const combined = (
      parentComments || []
    ).map((comment) => ({
      ...comment,
      replies:
        repliesByParent.get(
          String(comment.id)
        ) || [],
    }))

    const allCommentIds =
      combined.flatMap((comment) => [
        comment.id,
        ...(comment.replies || []).map(
          (reply) => reply.id
        ),
      ])

    const likedIds =
      await readLikedCommentIds(
        userId,
        allCommentIds
      )
    const total =
      await countVisibleComments(
        promotionId
      )

    const {
      count: parentCount,
      error: parentCountError,
    } = await supabase
      .from(
        'shadow_mall_promotion_comments'
      )
      .select('id', {
        count: 'exact',
        head: true,
      })
      .eq(
        'promotion_id',
        promotionId
      )
      .eq('is_hidden', false)
      .is('parent_id', null)

    if (parentCountError) {
      throw parentCountError
    }

    return res.status(200).json({
      ok: true,
      comments: combined.map(
        (comment) =>
          publicComment(
            comment,
            likedIds
          )
      ),
      page,
      limit,
      total,
      has_more:
        page * limit <
        Number(parentCount || 0),
    })
  } catch (error) {
    console.error(
      'GET SHADOW MALL PROMOTION COMMENTS ERROR:',
      error
    )

    return res.status(500).json({
      ok: false,
      message:
        error.message ||
        'Failed to load comments',
    })
  }
}

export async function createShadowMallPromotionComment(
  req,
  res
) {
  try {
    const userId = getUserId(req)
    const promotionId = getPromotionId(
      req.params.promotionId
    )
    const text = normalizeText(
      req.body.text
    )
    const parentId =
      String(
        req.body.parent_id ||
          req.body.parentId ||
          ''
      ).trim() || null

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    if (!promotionId) {
      return res.status(400).json({
        ok: false,
        message:
          'Promotion ID is required',
      })
    }

    if (!text) {
      return res.status(400).json({
        ok: false,
        message:
          'Comment text is required',
      })
    }

    if (text.length > COMMENT_LIMIT) {
      return res.status(400).json({
        ok: false,
        message: `Comment must be ${COMMENT_LIMIT} characters or fewer`,
      })
    }

    const promotion =
      await readPromotion(promotionId)

    if (!promotion) {
      return res.status(404).json({
        ok: false,
        message:
          'Shadow Mall promotion not found',
      })
    }

    if (parentId) {
      const {
        data: parentComment,
        error: parentError,
      } = await supabase
        .from(
          'shadow_mall_promotion_comments'
        )
        .select(
          'id, promotion_id, parent_id, is_hidden'
        )
        .eq('id', parentId)
        .eq(
          'promotion_id',
          promotionId
        )
        .eq('is_hidden', false)
        .maybeSingle()

      if (parentError) {
        throw parentError
      }

      if (
        !parentComment ||
        parentComment.parent_id
      ) {
        return res.status(400).json({
          ok: false,
          message:
            'Reply target is not valid',
        })
      }
    }

    const {
      data: createdComment,
      error: createError,
    } = await supabase
      .from(
        'shadow_mall_promotion_comments'
      )
      .insert({
        promotion_id: promotionId,
        user_id: userId,
        parent_id: parentId,
        text,
      })
      .select(
        '*, user:users(id, name, username, avatar_url, role)'
      )
      .single()

    if (createError) {
      throw createError
    }

    const commentCount =
      await countVisibleComments(
        promotionId
      )

    await updatePromotionCommentCount(
      promotionId,
      commentCount
    )

    return res.status(201).json({
      ok: true,
      comment: publicComment(
        createdComment
      ),
      comment_count: commentCount,
    })
  } catch (error) {
    console.error(
      'CREATE SHADOW MALL PROMOTION COMMENT ERROR:',
      error
    )

    return res.status(500).json({
      ok: false,
      message:
        error.message ||
        'Failed to create comment',
    })
  }
}

export async function updateOwnShadowMallPromotionComment(
  req,
  res
) {
  try {
    const userId = getUserId(req)
    const commentId = String(
      req.params.commentId || ''
    ).trim()
    const text = normalizeText(
      req.body.text
    )

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    if (!text) {
      return res.status(400).json({
        ok: false,
        message:
          'Comment text is required',
      })
    }

    if (text.length > COMMENT_LIMIT) {
      return res.status(400).json({
        ok: false,
        message: `Comment must be ${COMMENT_LIMIT} characters or fewer`,
      })
    }

    const {
      data: existingComment,
      error: findError,
    } = await supabase
      .from(
        'shadow_mall_promotion_comments'
      )
      .select(
        'id, user_id, is_hidden'
      )
      .eq('id', commentId)
      .maybeSingle()

    if (findError) throw findError

    if (
      !existingComment ||
      existingComment.is_hidden
    ) {
      return res.status(404).json({
        ok: false,
        message:
          'Comment not found',
      })
    }

    if (
      String(
        existingComment.user_id
      ) !== String(userId)
    ) {
      return res.status(403).json({
        ok: false,
        message:
          'You can only edit your own comment',
      })
    }

    const {
      data: updatedComment,
      error: updateError,
    } = await supabase
      .from(
        'shadow_mall_promotion_comments'
      )
      .update({
        text,
        updated_at:
          new Date().toISOString(),
      })
      .eq('id', commentId)
      .eq('user_id', userId)
      .select(
        '*, user:users(id, name, username, avatar_url, role)'
      )
      .single()

    if (updateError) {
      throw updateError
    }

    const { data: liked } =
      await supabase
        .from(
          'shadow_mall_promotion_comment_likes'
        )
        .select('id')
        .eq(
          'comment_id',
          commentId
        )
        .eq('user_id', userId)
        .maybeSingle()

    return res.status(200).json({
      ok: true,
      comment: publicComment(
        updatedComment,
        liked
          ? new Set([commentId])
          : new Set()
      ),
    })
  } catch (error) {
    console.error(
      'UPDATE SHADOW MALL PROMOTION COMMENT ERROR:',
      error
    )

    return res.status(500).json({
      ok: false,
      message:
        error.message ||
        'Failed to update comment',
    })
  }
}

export async function deleteOwnShadowMallPromotionComment(
  req,
  res
) {
  try {
    const userId = getUserId(req)
    const commentId = String(
      req.params.commentId || ''
    ).trim()

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    const {
      data: existingComment,
      error: findError,
    } = await supabase
      .from(
        'shadow_mall_promotion_comments'
      )
      .select(
        'id, promotion_id, user_id, parent_id'
      )
      .eq('id', commentId)
      .maybeSingle()

    if (findError) throw findError

    if (!existingComment) {
      return res.status(404).json({
        ok: false,
        message:
          'Comment not found',
      })
    }

    if (
      String(
        existingComment.user_id
      ) !== String(userId)
    ) {
      return res.status(403).json({
        ok: false,
        message:
          'You can only delete your own comment',
      })
    }

    const { error: deleteError } =
      await supabase
        .from(
          'shadow_mall_promotion_comments'
        )
        .delete()
        .eq('id', commentId)
        .eq('user_id', userId)

    if (deleteError) {
      throw deleteError
    }

    const commentCount =
      await countVisibleComments(
        existingComment.promotion_id
      )

    await updatePromotionCommentCount(
      existingComment.promotion_id,
      commentCount
    )

    return res.status(200).json({
      ok: true,
      message: 'Comment deleted',
      comment_count: commentCount,
    })
  } catch (error) {
    console.error(
      'DELETE SHADOW MALL PROMOTION COMMENT ERROR:',
      error
    )

    return res.status(500).json({
      ok: false,
      message:
        error.message ||
        'Failed to delete comment',
    })
  }
}

export async function toggleShadowMallPromotionCommentLike(
  req,
  res
) {
  try {
    const userId = getUserId(req)
    const commentId = String(
      req.params.commentId || ''
    ).trim()

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    const {
      data: comment,
      error: commentError,
    } = await supabase
      .from(
        'shadow_mall_promotion_comments'
      )
      .select('id, is_hidden')
      .eq('id', commentId)
      .maybeSingle()

    if (commentError) {
      throw commentError
    }

    if (
      !comment ||
      comment.is_hidden
    ) {
      return res.status(404).json({
        ok: false,
        message:
          'Comment not found',
      })
    }

    const {
      data: existingLike,
      error: likeLookupError,
    } = await supabase
      .from(
        'shadow_mall_promotion_comment_likes'
      )
      .select('id')
      .eq('comment_id', commentId)
      .eq('user_id', userId)
      .maybeSingle()

    if (likeLookupError) {
      throw likeLookupError
    }

    let liked = false

    if (existingLike?.id) {
      const { error } =
        await supabase
          .from(
            'shadow_mall_promotion_comment_likes'
          )
          .delete()
          .eq('id', existingLike.id)

      if (error) throw error
    } else {
      const { error } =
        await supabase
          .from(
            'shadow_mall_promotion_comment_likes'
          )
          .insert({
            comment_id: commentId,
            user_id: userId,
          })

      if (error) throw error

      liked = true
    }

    const {
      count,
      error: countError,
    } = await supabase
      .from(
        'shadow_mall_promotion_comment_likes'
      )
      .select('id', {
        count: 'exact',
        head: true,
      })
      .eq('comment_id', commentId)

    if (countError) {
      throw countError
    }

    const likes = Number(count || 0)

    const { error: updateError } =
      await supabase
        .from(
          'shadow_mall_promotion_comments'
        )
        .update({ likes })
        .eq('id', commentId)

    if (updateError) {
      throw updateError
    }

    return res.status(200).json({
      ok: true,
      comment_id: commentId,
      liked,
      likes,
    })
  } catch (error) {
    console.error(
      'TOGGLE SHADOW MALL PROMOTION COMMENT LIKE ERROR:',
      error
    )

    return res.status(500).json({
      ok: false,
      message:
        error.message ||
        'Failed to update like',
    })
  }
}

export async function getShadowMallPromotionEchoes(
  req,
  res
) {
  try {
    const viewerId = getUserId(req)
    const promotionId = getPromotionId(
      req.params.promotionId
    )
    const page = Math.max(
      1,
      Number(req.query.page || 1)
    )
    const limit = Math.min(
      50,
      Math.max(
        1,
        Number(req.query.limit || 20)
      )
    )
    const from =
      (page - 1) * limit
    const to = from + limit - 1

    if (!viewerId) {
      return res.status(401).json({
        ok: false,
        message:
          'Login is required',
      })
    }

    if (!promotionId) {
      return res.status(400).json({
        ok: false,
        message:
          'Promotion ID is required',
      })
    }

    const promotion =
      await readPromotion(promotionId)

    if (!promotion) {
      return res.status(404).json({
        ok: false,
        message:
          'Shadow Mall promotion not found',
      })
    }

    const { data, error, count } =
      await supabase
        .from(
          'shadow_mall_promotion_echoes'
        )
        .select(
          'id, promotion_id, user_id, echo_text, destination, audience, created_at, user:users(id, name, username, avatar_url)',
          { count: 'exact' }
        )
        .eq(
          'promotion_id',
          promotionId
        )
        .or(
          `audience.eq.public,user_id.eq.${viewerId}`
        )
        .order('created_at', {
          ascending: false,
        })
        .range(from, to)

    if (error) throw error

    const total = Number(count || 0)

    return res.status(200).json({
      ok: true,
      promotion: {
        id: promotion.id,
        sponsor:
          promotion.sponsor ||
          'Shadow Mall',
        title:
          promotion.title || '',
        description:
          promotion.description || '',
        echo_count: Number(
          promotion.echo_count || 0
        ),
      },
      post: {
        id: String(promotion.id),
        user_id: null,
        content:
          promotion.description ||
          promotion.title ||
          '',
        echo_count: Number(
          promotion.echo_count || 0
        ),
        user: {
          id: null,
          name:
            promotion.sponsor ||
            'Shadow Mall',
          username: '',
          avatar_url:
            promotion.profile_image_url ||
            '',
        },
      },
      total,
      page,
      limit,
      has_more:
        to + 1 < total,
      echoes: (data || []).map(
        publicEcho
      ),
    })
  } catch (error) {
    console.error(
      'GET SHADOW MALL PROMOTION ECHOES ERROR:',
      error
    )

    return res.status(500).json({
      ok: false,
      message:
        error.message ||
        'Failed to load promotion echoes',
    })
  }
}

export async function createShadowMallPromotionEcho(
  req,
  res
) {
  try {
    const userId = getUserId(req)
    const promotionId = getPromotionId(
      req.params.promotionId
    )

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message:
          'Login is required',
      })
    }

    if (!promotionId) {
      return res.status(400).json({
        ok: false,
        message:
          'Promotion ID is required',
      })
    }

    const promotion =
      await readPromotion(promotionId)

    if (!promotion) {
      return res.status(404).json({
        ok: false,
        message:
          'Shadow Mall promotion not found',
      })
    }

    const echoText = cleanText(
      req.body?.echo_text,
      280
    )
    const destination =
      normalizeChoice(
        req.body?.destination,
        DESTINATIONS,
        'feed'
      )
    const audience =
      normalizeChoice(
        req.body?.audience,
        AUDIENCES,
        'public'
      )

    const { data, error } =
      await supabase
        .from(
          'shadow_mall_promotion_echoes'
        )
        .insert({
          promotion_id:
            promotionId,
          user_id: userId,
          echo_text: echoText,
          destination,
          audience,
        })
        .select(
          'id, promotion_id, user_id, echo_text, destination, audience, created_at'
        )
        .single()

    if (error) throw error

    const echoCount =
      await readEchoCount(
        promotionId
      )

    await updatePromotionEchoCount(
      promotionId,
      echoCount
    )

    const reader =
      await readUser(userId)

    return res.status(201).json({
      ok: true,
      echo_count: echoCount,
      echo: publicEcho({
        ...data,
        user: reader,
      }),
    })
  } catch (error) {
    console.error(
      'CREATE SHADOW MALL PROMOTION ECHO ERROR:',
      error
    )

    return res.status(500).json({
      ok: false,
      message:
        error.message ||
        'Failed to echo promotion',
    })
  }
}
