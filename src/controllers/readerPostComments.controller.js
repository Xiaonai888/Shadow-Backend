import { supabase } from '../config/supabase.js'

const COMMENT_LIMIT = 1000
const DEFAULT_PAGE_SIZE = 20
const MAX_PAGE_SIZE = 30

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

function publicComment(comment, likedIds = new Set()) {
  if (!comment) return null

  const user = Array.isArray(comment.user)
    ? comment.user[0]
    : comment.user

  return {
    id: comment.id,
    post_id: comment.post_id,
    user_id: comment.user_id,
    parent_id: comment.parent_id || null,
    text: comment.text || '',
    likes: Number(comment.likes || 0),
    liked: likedIds.has(String(comment.id)),
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
          publicComment(reply, likedIds)
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

async function readLikedIds(userId, commentIds) {
  if (!userId || !commentIds.length) {
    return new Set()
  }

  const { data, error } = await supabase
    .from('reader_post_comment_likes')
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

export async function getReaderPostComments(
  req,
  res
) {
  try {
    const userId = getUserId(req)
    const postId = String(
      req.params.postId || ''
    ).trim()
    const sort = String(
      req.query.sort || 'top'
    )
      .trim()
      .toLowerCase()
    const { page, limit, from, to } =
      getPagination(req)

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
      .select(
        '*, user:users(id, name, username, avatar_url, role)'
      )
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
    } = await parentQuery.range(from, to)

    if (parentError) throw parentError

    const parentIds = (
      parentComments || []
    )
      .map((comment) => comment.id)
      .filter(Boolean)

    let replies = []

    if (parentIds.length) {
      const { data, error } = await supabase
        .from('reader_post_comments')
        .select(
          '*, user:users(id, name, username, avatar_url, role)'
        )
        .eq('post_id', postId)
        .eq('is_hidden', false)
        .in('parent_id', parentIds)
        .order('created_at', {
          ascending: true,
        })

      if (error) throw error
      replies = data || []
    }

    const repliesByParent = new Map()

    for (const reply of replies) {
      const key = String(
        reply.parent_id || ''
      )
      const current =
        repliesByParent.get(key) || []
      current.push(reply)
      repliesByParent.set(key, current)
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

    const allCommentIds = combined.flatMap(
      (comment) => [
        comment.id,
        ...(comment.replies || []).map(
          (reply) => reply.id
        ),
      ]
    )

    const likedIds = await readLikedIds(
      userId,
      allCommentIds
    )

    const total =
      await countVisibleComments(postId)

    const {
      count: parentCount,
      error: parentCountError,
    } = await supabase
      .from('reader_post_comments')
      .select('id', {
        count: 'exact',
        head: true,
      })
      .eq('post_id', postId)
      .eq('is_hidden', false)
      .is('parent_id', null)

    if (parentCountError) {
      throw parentCountError
    }

    return res.status(200).json({
      ok: true,
      comments: combined.map((comment) =>
        publicComment(comment, likedIds)
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

export async function createReaderPostComment(
  req,
  res
) {
  try {
    const userId = getUserId(req)
    const postId = String(
      req.params.postId || ''
    ).trim()
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
        '*, user:users(id, name, username, avatar_url, role)'
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
        '*, user:users(id, name, username, avatar_url, role)'
      )
      .single()

    if (updateError) throw updateError

    const { data: liked } = await supabase
      .from('reader_post_comment_likes')
      .select('id')
      .eq('comment_id', commentId)
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

    if (commentError) throw commentError

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
      .from('reader_post_comment_likes')
      .select('id')
      .eq('comment_id', commentId)
      .eq('user_id', userId)
      .maybeSingle()

    if (likeLookupError) {
      throw likeLookupError
    }

    let liked = false

    if (existingLike?.id) {
      const { error } = await supabase
        .from('reader_post_comment_likes')
        .delete()
        .eq('id', existingLike.id)

      if (error) throw error
    } else {
      const { error } = await supabase
        .from('reader_post_comment_likes')
        .insert({
          comment_id: commentId,
          user_id: userId,
        })

      if (error) throw error
      liked = true
    }

    const { count, error: countError } =
      await supabase
        .from('reader_post_comment_likes')
        .select('id', {
          count: 'exact',
          head: true,
        })
        .eq('comment_id', commentId)

    if (countError) throw countError

    const likes = Number(count || 0)

    const { error: updateError } =
      await supabase
        .from('reader_post_comments')
        .update({ likes })
        .eq('id', commentId)

    if (updateError) throw updateError

    return res.status(200).json({
      ok: true,
      comment_id: commentId,
      liked,
      likes,
    })
  } catch (error) {
    console.error(
      'TOGGLE READER POST COMMENT LIKE ERROR:',
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
