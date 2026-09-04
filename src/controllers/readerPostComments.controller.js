import { supabase } from '../config/supabase.js'

const COMMENT_LIMIT = 1000
const DEFAULT_PAGE_SIZE = 20
const MAX_PAGE_SIZE = 30
const DEFAULT_REPLY_PAGE_SIZE = 5
const MAX_REPLY_PAGE_SIZE = 20
const COMMENT_SELECT =
  'id, post_id, user_id, parent_id, text, likes, is_hidden, created_at, updated_at, user:users(id, name, username, avatar_url, role)'

const COMMENT_REACTION_TYPES = new Set([
  'love',
  'haha',
  'wow',
  'sad',
  'angry',
  'support',
  'touched',
])

function normalizeReactionType(value) {
  const reactionType = String(
    value || 'love'
  )
    .trim()
    .toLowerCase()

  return COMMENT_REACTION_TYPES.has(
    reactionType
  )
    ? reactionType
    : 'love'
}

function getUserId(req) {
  return String(
    req.user?.user_id ||
      req.user?.id ||
      ''
  ).trim()
}

function normalizeText(value) {
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .trim()
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

function publicComment(
  comment,
  reactionMap = new Map()
) {
  if (!comment) return null

  const user = Array.isArray(comment.user)
    ? comment.user[0]
    : comment.user

  const reactionType =
    reactionMap.get(
      String(comment.id)
    ) || null

  return {
    id: comment.id,
    post_id: comment.post_id,
    user_id: comment.user_id,
    parent_id: comment.parent_id || null,
    text: comment.text || '',
    likes: Number(comment.likes || 0),
    liked: Boolean(reactionType),
    reaction_type: reactionType,
    is_hidden: Boolean(comment.is_hidden),
    created_at: comment.created_at,
    updated_at: comment.updated_at,
    user: user
      ? {
          id: user.id,
          name:
            user.name ||
            user.username ||
            'Reader',
          username: user.username || '',
          avatar_url: user.avatar_url || '',
          role: user.role || 'reader',
        }
      : {
          id: comment.user_id,
          name: 'Reader',
          username: '',
          avatar_url: '',
          role: 'reader',
        },
    replies: Array.isArray(comment.replies)
      ? comment.replies.map((reply) =>
          publicComment(
            reply,
            reactionMap
          )
        )
      : [],
  }
}

async function readPost(postId) {
  const { data, error } = await supabase
    .from('reader_posts')
    .select(
      'id, user_id, comments_permission, comment_count, deleted_at'
    )
    .eq('id', postId)
    .is('deleted_at', null)
    .maybeSingle()

  if (error) throw error

  return data
}

async function canUserComment(post, userId) {
  if (!post || !userId) return false

  if (
    String(post.user_id) === String(userId)
  ) {
    return true
  }

  const permission = String(
    post.comments_permission || 'everyone'
  )
    .trim()
    .toLowerCase()

  if (permission === 'everyone') return true
  if (permission === 'no_one') return false

  const { data: viewerFollowsOwner, error } =
    await supabase
      .from('user_follows')
      .select('follower_user_id')
      .eq('follower_user_id', userId)
      .eq('following_user_id', post.user_id)
      .maybeSingle()

  if (error) throw error

  if (permission === 'followers') {
    return Boolean(viewerFollowsOwner)
  }

  if (permission === 'friends') {
    if (!viewerFollowsOwner) return false

    const { data: ownerFollowsViewer, error: reverseError } =
      await supabase
        .from('user_follows')
        .select('follower_user_id')
        .eq('follower_user_id', post.user_id)
        .eq('following_user_id', userId)
        .maybeSingle()

    if (reverseError) throw reverseError

    return Boolean(ownerFollowsViewer)
  }

  return true
}

async function countVisibleComments(postId) {
  const { count, error } = await supabase
    .from('reader_post_comments')
    .select('id', {
      count: 'exact',
      head: true,
    })
    .eq('post_id', postId)
    .eq('is_hidden', false)

  if (error) throw error

  return Number(count || 0)
}

async function updatePostCommentCount(
  postId,
  commentCount
) {
  const { error } = await supabase
    .from('reader_posts')
    .update({
      comment_count: Number(commentCount || 0),
    })
    .eq('id', postId)
    .is('deleted_at', null)

  if (error) throw error
}

async function readReactionMap(
  userId,
  commentIds
) {
  if (!userId || !commentIds.length) {
    return new Map()
  }

  const { data, error } = await supabase
    .from('reader_post_comment_likes')
    .select(
      'comment_id, reaction_type'
    )
    .eq('user_id', userId)
    .in('comment_id', commentIds)

  if (error) throw error

  return new Map(
    (data || []).map((item) => [
      String(item.comment_id),
      normalizeReactionType(
        item.reaction_type
      ),
    ])
  )
}


async function loadReplyPage({
  postId,
  parentId,
  page = 1,
  limit = DEFAULT_REPLY_PAGE_SIZE,
}) {
  const safePage = Math.max(
    1,
    Number.parseInt(page, 10) || 1
  )
  const safeLimit = Math.min(
    MAX_REPLY_PAGE_SIZE,
    Math.max(
      1,
      Number.parseInt(limit, 10) ||
        DEFAULT_REPLY_PAGE_SIZE
    )
  )
  const from =
    (safePage - 1) * safeLimit
  const to =
    from + safeLimit - 1

  const {
    data,
    error,
    count,
  } = await supabase
    .from('reader_post_comments')
    .select(COMMENT_SELECT, {
      count: 'exact',
    })
    .eq('post_id', postId)
    .eq('is_hidden', false)
    .eq('parent_id', parentId)
    .order('created_at', {
      ascending: true,
    })
    .range(from, to)

  if (error) throw error

  const rows = data || []
  const total = Number(count || 0)

  return {
    rows,
    total,
    page: safePage,
    limit: safeLimit,
    hasMore:
      safePage * safeLimit < total,
  }
}


export async function getReaderPostComments(
  req,
  res
) {
  try {
    const userId = getUserId(req)
    const rawPostId = String(
      req.params.postId || ''
    ).trim()
    const postId =
      await resolveReaderPostId(rawPostId)
    const sort = String(
      req.query.sort || 'top'
    )
      .trim()
      .toLowerCase()
    const { page, limit, from, to } =
      getPagination(req)
    const replyLimit = Math.min(
      MAX_REPLY_PAGE_SIZE,
      Math.max(
        1,
        Number.parseInt(
          req.query.reply_limit,
          10
        ) ||
          DEFAULT_REPLY_PAGE_SIZE
      )
    )

    if (!postId) {
      return res.status(400).json({
        ok: false,
        message: 'Post ID is required',
      })
    }

    const post = await readPost(postId)

    if (!post) {
      return res.status(404).json({
        ok: false,
        message: 'Post not found',
      })
    }

    let parentQuery = supabase
      .from('reader_post_comments')
      .select(COMMENT_SELECT, {
        count: 'exact',
      })
      .eq('post_id', postId)
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
      parentQuery = parentQuery.order(
        'created_at',
        {
          ascending: false,
        }
      )
    }

    const {
      data: parentComments,
      error: parentError,
      count: parentCount,
    } = await parentQuery.range(from, to)

    if (parentError) throw parentError

    const parents = parentComments || []

    const [
      replyResults,
      total,
    ] = await Promise.all([
      Promise.all(
        parents.map(
          async (parent) => ({
            parentId: String(parent.id),
            result: await loadReplyPage({
              postId,
              parentId: parent.id,
              page: 1,
              limit: replyLimit,
            }),
          })
        )
      ),
      countVisibleComments(postId),
    ])

    const replyResultMap = new Map(
      replyResults.map(
        ({ parentId, result }) => [
          parentId,
          result,
        ]
      )
    )

    const replyRows = parents.flatMap(
      (parent) =>
        replyResultMap.get(
          String(parent.id)
        )?.rows || []
    )

    const allCommentIds = [
      ...parents.map(
        (comment) => comment.id
      ),
      ...replyRows.map(
        (reply) => reply.id
      ),
    ]

    const reactionMap =
      await readReactionMap(
        userId,
        allCommentIds
      )

    const commentsWithReplies =
      parents.map((comment) => {
        const result =
          replyResultMap.get(
            String(comment.id)
          ) || {
            rows: [],
            total: 0,
            page: 0,
            hasMore: false,
          }

        return {
          ...publicComment(
            comment,
            reactionMap
          ),
          replies: result.rows.map(
            (reply) =>
              publicComment(
                reply,
                reactionMap
              )
          ),
          reply_total:
            Number(result.total || 0),
          reply_page:
            result.total > 0
              ? Number(result.page || 1)
              : 0,
          reply_has_more:
            Boolean(result.hasMore),
        }
      })

    return res.status(200).json({
      ok: true,
      comments: commentsWithReplies,
      page,
      limit,
      total,
      has_more:
        page * limit <
        Number(parentCount || 0),
    })
  } catch (error) {
    console.error(
      'GET READER POST COMMENTS ERROR:',
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

export async function getReaderPostCommentReplies(
  req,
  res
) {
  try {
    const userId = getUserId(req)
    const commentId = String(
      req.params.commentId || ''
    ).trim()
    const page = Math.max(
      1,
      Number.parseInt(
        req.query.page,
        10
      ) || 1
    )
    const limit = Math.min(
      MAX_REPLY_PAGE_SIZE,
      Math.max(
        1,
        Number.parseInt(
          req.query.limit,
          10
        ) ||
          DEFAULT_REPLY_PAGE_SIZE
      )
    )

    if (!commentId) {
      return res.status(400).json({
        ok: false,
        message: 'Comment ID is required',
      })
    }

    const {
      data: parent,
      error: parentError,
    } = await supabase
      .from('reader_post_comments')
      .select(
        'id, post_id, parent_id, is_hidden'
      )
      .eq('id', commentId)
      .maybeSingle()

    if (parentError) throw parentError

    if (
      !parent ||
      parent.parent_id ||
      parent.is_hidden
    ) {
      return res.status(404).json({
        ok: false,
        message: 'Comment not found',
      })
    }

    const result = await loadReplyPage({
      postId: parent.post_id,
      parentId: parent.id,
      page,
      limit,
    })

    const reactionMap =
      await readReactionMap(
        userId,
        result.rows.map(
          (reply) => reply.id
        )
      )

    return res.status(200).json({
      ok: true,
      replies: result.rows.map(
        (reply) =>
          publicComment(
            reply,
            reactionMap
          )
      ),
      page: result.page,
      limit: result.limit,
      total: result.total,
      has_more: result.hasMore,
    })
  } catch (error) {
    console.error(
      'GET READER POST COMMENT REPLIES ERROR:',
      error
    )

    return res.status(500).json({
      ok: false,
      message:
        error.message ||
        'Failed to load replies',
    })
  }
}

export async function createReaderPostComment(
  req,
  res
) {
  try {
    const userId = getUserId(req)
    const rawPostId = String(
      req.params.postId || ''
    ).trim()
    const postId =
      await resolveReaderPostId(rawPostId)
    const text = normalizeText(req.body.text)
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

    if (!postId) {
      return res.status(400).json({
        ok: false,
        message: 'Post ID is required',
      })
    }

    if (!text) {
      return res.status(400).json({
        ok: false,
        message: 'Comment text is required',
      })
    }

    if (text.length > COMMENT_LIMIT) {
      return res.status(400).json({
        ok: false,
        message: `Comment must be ${COMMENT_LIMIT} characters or fewer`,
      })
    }

    const post = await readPost(postId)

    if (!post) {
      return res.status(404).json({
        ok: false,
        message: 'Post not found',
      })
    }

    if (!(await canUserComment(post, userId))) {
      return res.status(403).json({
        ok: false,
        message:
          'You cannot comment on this post',
      })
    }

    if (parentId) {
      const {
        data: parentComment,
        error: parentError,
      } = await supabase
        .from('reader_post_comments')
        .select(
          'id, post_id, parent_id, is_hidden'
        )
        .eq('id', parentId)
        .eq('post_id', postId)
        .eq('is_hidden', false)
        .maybeSingle()

      if (parentError) throw parentError

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
      .from('reader_post_comments')
      .insert({
        post_id: postId,
        user_id: userId,
        parent_id: parentId,
        text,
      })
      .select(
        COMMENT_SELECT
      )
      .single()

    if (createError) throw createError

    const commentCount =
      await countVisibleComments(postId)
    await updatePostCommentCount(
      postId,
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
      'CREATE READER POST COMMENT ERROR:',
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

export async function updateOwnReaderPostComment(
  req,
  res
) {
  try {
    const userId = getUserId(req)
    const commentId = String(
      req.params.commentId || ''
    ).trim()
    const text = normalizeText(req.body.text)

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    if (!text) {
      return res.status(400).json({
        ok: false,
        message: 'Comment text is required',
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
      .from('reader_post_comments')
      .select('id, user_id')
      .eq('id', commentId)
      .maybeSingle()

    if (findError) throw findError

    if (!existingComment) {
      return res.status(404).json({
        ok: false,
        message: 'Comment not found',
      })
    }

    if (
      String(existingComment.user_id) !==
      String(userId)
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
      .from('reader_post_comments')
      .update({
        text,
        updated_at:
          new Date().toISOString(),
      })
      .eq('id', commentId)
      .eq('user_id', userId)
      .select(
        COMMENT_SELECT
      )
      .single()

    if (updateError) throw updateError

    const { data: reaction } =
      await supabase
        .from(
          'reader_post_comment_likes'
        )
        .select(
          'comment_id, reaction_type'
        )
        .eq(
          'comment_id',
          commentId
        )
        .eq('user_id', userId)
        .maybeSingle()

    const reactionMap = new Map()

    if (reaction?.comment_id) {
      reactionMap.set(
        String(
          reaction.comment_id
        ),
        normalizeReactionType(
          reaction.reaction_type
        )
      )
    }

    return res.status(200).json({
      ok: true,
      comment: publicComment(
        updatedComment,
        reactionMap
      ),
    })
  } catch (error) {
    console.error(
      'UPDATE READER POST COMMENT ERROR:',
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

export async function deleteOwnReaderPostComment(
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
      .from('reader_post_comments')
      .select(
        'id, post_id, user_id, parent_id'
      )
      .eq('id', commentId)
      .maybeSingle()

    if (findError) throw findError

    if (!existingComment) {
      return res.status(404).json({
        ok: false,
        message: 'Comment not found',
      })
    }

    if (
      String(existingComment.user_id) !==
      String(userId)
    ) {
      return res.status(403).json({
        ok: false,
        message:
          'You can only delete your own comment',
      })
    }

    const { error: deleteError } =
      await supabase
        .from('reader_post_comments')
        .delete()
        .eq('id', commentId)
        .eq('user_id', userId)

    if (deleteError) throw deleteError

    const commentCount =
      await countVisibleComments(
        existingComment.post_id
      )
    await updatePostCommentCount(
      existingComment.post_id,
      commentCount
    )

    return res.status(200).json({
      ok: true,
      message: 'Comment deleted',
      comment_count: commentCount,
    })
  } catch (error) {
    console.error(
      'DELETE READER POST COMMENT ERROR:',
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

export async function toggleReaderPostCommentLike(
  req,
  res
) {
  try {
    const userId = getUserId(req)
    const commentId = String(
      req.params.commentId || ''
    ).trim()
    const reactionType =
      normalizeReactionType(
        req.body?.reaction_type
      )

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
      .from('reader_post_comments')
      .select('id, is_hidden')
      .eq('id', commentId)
      .maybeSingle()

    if (commentError) {
      throw commentError
    }

    if (!comment || comment.is_hidden) {
      return res.status(404).json({
        ok: false,
        message: 'Comment not found',
      })
    }

    const {
      data: existingLike,
      error: likeLookupError,
    } = await supabase
      .from(
        'reader_post_comment_likes'
      )
      .select(
        'id, reaction_type'
      )
      .eq(
        'comment_id',
        commentId
      )
      .eq('user_id', userId)
      .maybeSingle()

    if (likeLookupError) {
      throw likeLookupError
    }

    let liked = false
    let activeReactionType = null

    if (existingLike?.id) {
      const existingReactionType =
        normalizeReactionType(
          existingLike.reaction_type
        )

      if (
        existingReactionType !==
        reactionType
      ) {
        const { error } =
          await supabase
            .from(
              'reader_post_comment_likes'
            )
            .update({
              reaction_type:
                reactionType,
            })
            .eq(
              'id',
              existingLike.id
            )

        if (error) throw error

        liked = true
        activeReactionType =
          reactionType
      } else {
        const { error } =
          await supabase
            .from(
              'reader_post_comment_likes'
            )
            .delete()
            .eq(
              'id',
              existingLike.id
            )

        if (error) throw error
      }
    } else {
      const { error } =
        await supabase
          .from(
            'reader_post_comment_likes'
          )
          .insert({
            comment_id:
              commentId,
            user_id:
              userId,
            reaction_type:
              reactionType,
          })

      if (error) throw error

      liked = true
      activeReactionType =
        reactionType
    }

    const {
      count,
      error: countError,
    } = await supabase
      .from(
        'reader_post_comment_likes'
      )
      .select('id', {
        count: 'exact',
        head: true,
      })
      .eq(
        'comment_id',
        commentId
      )

    if (countError) {
      throw countError
    }

    const likes =
      Number(count || 0)

    const { error: updateError } =
      await supabase
        .from(
          'reader_post_comments'
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
      reaction_type:
        activeReactionType,
      likes,
    })
  } catch (error) {
    console.error(
      'TOGGLE READER POST COMMENT REACTION ERROR:',
      error
    )

    return res.status(500).json({
      ok: false,
      message:
        error.message ||
        'Failed to update reaction',
    })
  }
}
