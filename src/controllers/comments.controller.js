import jwt from 'jsonwebtoken'
import { supabase } from '../config/supabase.js'
import { incrementAuthorPageAnalytics } from '../services/authorAnalytics.service.js'
import {
  getActiveReaderCommentBlock,
  readerCommentBlockedPayload,
} from '../utils/readerCommentBlocks.js'
import { createAuthorStoryNotificationSafely } from '../services/authorStoryNotifications.service.js'
import {
  deleteStoryCommentToTrash,
  getCommentTrashMessage,
  getCommentTrashStatus,
} from '../services/commentTrash.service.js'
import {
  authorHiddenCommentPayload,
  findAuthorBlockedWordsInComment,
  saveAuthorHiddenCommentReview,
} from '../utils/authorCommentProtection.js'

const COMMENT_BAN_DURATIONS = {
  '1h': 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '3d': 3 * 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
}

const COMMENT_BAN_PREFIX = '[TEMP_UNTIL:'
const LEGACY_BAN_MILLISECONDS =
  7 * 24 * 60 * 60 * 1000

function normalizeText(value) {
  return String(value || '').trim()
}

function getRequestUserId(req) {
  try {
    const authHeader =
      req.headers.authorization || ''
    const token = authHeader.startsWith(
      'Bearer '
    )
      ? authHeader.slice(7)
      : ''

    if (!token) return null

    const decoded = jwt.verify(
      token,
      process.env.JWT_SECRET
    )

    if (decoded.type !== 'reader') {
      return null
    }

    return decoded.user_id || null
  } catch {
    return null
  }
}

function normalizeRelatedUser(user) {
  return Array.isArray(user)
    ? user[0] || null
    : user || null
}

function publicUser(user) {
  const safeUser =
    normalizeRelatedUser(user)

  if (!safeUser) {
    return {
      id: null,
      name: 'Reader',
      username: '',
      avatar_url: '',
      role: 'reader',
    }
  }

  return {
    id: safeUser.id,
    name:
      safeUser.name
      || safeUser.username
      || 'Reader',
    username:
      safeUser.username || '',
    avatar_url:
      safeUser.avatar_url || '',
    role:
      safeUser.role || 'reader',
  }
}

function publicComment(
  comment,
  likedIds = new Set()
) {
  const isDeleted = Boolean(
    comment.deleted_at
  )

  return {
    id: comment.id,
    story_id: comment.story_id,
    episode_id:
      comment.episode_id || null,
    user_id:
      isDeleted
        ? null
        : comment.user_id,
    parent_id:
      comment.parent_id || null,
    text:
      isDeleted
        ? 'Comment deleted'
        : comment.text,
    is_deleted: isDeleted,
    is_pinned:
      isDeleted
        ? false
        : Boolean(
            comment.is_pinned
          ),
    is_hidden:
      isDeleted
        ? false
        : Boolean(
            comment.is_hidden
          ),
    is_spoiler:
      isDeleted
        ? false
        : Boolean(
            comment.is_spoiler
          ),
    created_at:
      comment.created_at,
    updated_at:
      comment.updated_at,
    user:
      isDeleted
        ? publicUser(null)
        : publicUser(comment.user),
    likes:
      isDeleted
        ? 0
        : Number(
            comment.likes || 0
          ),
    liked:
      !isDeleted &&
      likedIds.has(
        String(comment.id)
      ),
  }
}

async function getStory(storyId) {
  const { data, error } =
    await supabase
      .from('stories')
      .select(
        'id, user_id, author_id, title, status, total_comments'
      )
      .eq('id', storyId)
      .maybeSingle()

  if (error) throw error

  return data
}

async function getEpisode(episodeId) {
  const { data, error } =
    await supabase
      .from('episodes')
      .select('id, story_id')
      .eq('id', episodeId)
      .maybeSingle()

  if (error) throw error

  return data
}

async function getComment(commentId) {
  const { data, error } =
    await supabase
      .from('comments')
      .select('*')
      .eq('id', commentId)
      .is('deleted_at', null)
      .maybeSingle()

  if (error) throw error

  return data
}

async function getPublicComment(
  commentId,
  userId = null
) {
  const { data, error } =
    await supabase
      .from('comments')
      .select(
        '*, user:users(id, name, username, avatar_url, role)'
      )
      .eq('id', commentId)
      .is('deleted_at', null)
      .maybeSingle()

  if (error) throw error
  if (!data) return null

  const likedIds = new Set()

  if (userId) {
    const { data: like } =
      await supabase
        .from('comment_likes')
        .select('comment_id')
        .eq(
          'comment_id',
          commentId
        )
        .eq('user_id', userId)
        .maybeSingle()

    if (like?.comment_id) {
      likedIds.add(
        String(like.comment_id)
      )
    }
  }

  return publicComment(
    data,
    likedIds
  )
}

async function getUser(userId) {
  const { data, error } =
    await supabase
      .from('users')
      .select(
        'id, name, username, avatar_url, role, is_author'
      )
      .eq('id', userId)
      .maybeSingle()

  if (error) throw error

  return data
}

function durationToExpiresAt(
  duration,
  fallback = '24h'
) {
  const safeDuration =
    COMMENT_BAN_DURATIONS[
      duration
    ]
      ? duration
      : fallback
  const milliseconds =
    COMMENT_BAN_DURATIONS[
      safeDuration
    ]

  return {
    duration: safeDuration,
    expiresAt: new Date(
      Date.now() + milliseconds
    ).toISOString(),
  }
}

function encodeBanReason(
  reason,
  expiresAt
) {
  const safeReason =
    normalizeText(reason)
    || 'Temporary story comment restriction'

  return `${COMMENT_BAN_PREFIX}${expiresAt}] ${safeReason}`
}

function parseBanReason(
  value,
  createdAt
) {
  const raw =
    normalizeText(value)
  const match = raw.match(
    /^\[TEMP_UNTIL:([^\]]+)\]\s*(.*)$/s
  )

  if (match) {
    const timestamp =
      new Date(match[1]).getTime()

    return {
      expiresAt:
        Number.isFinite(timestamp)
          ? new Date(
              timestamp
            ).toISOString()
          : null,
      reason:
        normalizeText(match[2])
        || 'Temporary story comment restriction',
      legacy: false,
    }
  }

  const createdTimestamp =
    new Date(
      createdAt || ''
    ).getTime()

  return {
    expiresAt:
      Number.isFinite(
        createdTimestamp
      )
        ? new Date(
            createdTimestamp
            + LEGACY_BAN_MILLISECONDS
          ).toISOString()
        : null,
    reason:
      raw
      || 'Temporary story comment restriction',
    legacy: true,
  }
}

async function removeCommentBan(
  banId
) {
  if (!banId) return

  const { error } =
    await supabase
      .from('comment_bans')
      .delete()
      .eq('id', banId)

  if (error) throw error
}

async function getActiveStoryCommentBan(
  storyId,
  userId
) {
  const { data, error } =
    await supabase
      .from('comment_bans')
      .select('*')
      .eq(
        'story_id',
        storyId
      )
      .eq('user_id', userId)
      .maybeSingle()

  if (error) throw error
  if (!data) return null

  const parsed = parseBanReason(
    data.reason,
    data.created_at
  )
  const expiresTimestamp =
    new Date(
      parsed.expiresAt || ''
    ).getTime()

  if (
    !Number.isFinite(
      expiresTimestamp
    ) ||
    expiresTimestamp <= Date.now()
  ) {
    await removeCommentBan(
      data.id
    )
    return null
  }

  const retryAfterSeconds =
    Math.max(
      1,
      Math.ceil(
        (
          expiresTimestamp
          - Date.now()
        ) / 1000
      )
    )

  if (parsed.legacy) {
    const { error: updateError } =
      await supabase
        .from('comment_bans')
        .update({
          reason: encodeBanReason(
            parsed.reason,
            parsed.expiresAt
          ),
        })
        .eq('id', data.id)

    if (updateError) {
      console.warn(
        'NORMALIZE LEGACY COMMENT BAN WARNING:',
        updateError.message
      )
    }
  }

  return {
    id: data.id,
    story_id: storyId,
    user_id: userId,
    reason: parsed.reason,
    restriction_until:
      parsed.expiresAt,
    retry_after_seconds:
      retryAfterSeconds,
  }
}

function sendStoryBanResponse(
  res,
  ban
) {
  res.setHeader(
    'Retry-After',
    String(
      ban.retry_after_seconds
    )
  )

  return res.status(403).json({
    ok: false,
    code:
      'STORY_COMMENT_RESTRICTED',
    message:
      'Your commenting access for this story is temporarily restricted.',
    reason: ban.reason,
    restriction_until:
      ban.restriction_until,
    retry_after_seconds:
      ban.retry_after_seconds,
  })
}

async function canModerateStory(
  storyId,
  userId
) {
  const [story, user] =
    await Promise.all([
      getStory(storyId),
      getUser(userId),
    ])

  if (!story || !user) {
    return {
      ok: false,
      story,
      user,
      isAdmin: false,
      isAuthor: false,
    }
  }

  const isAdmin =
    user.role === 'admin'
    || user.role === 'super_admin'
  const isAuthor =
    String(
      story.user_id || ''
    ) === String(userId)

  return {
    ok:
      isAdmin || isAuthor,
    story,
    user,
    isAdmin,
    isAuthor,
  }
}

async function getLikedIds(
  commentIds,
  userId
) {
  if (
    !userId ||
    !commentIds.length
  ) {
    return new Set()
  }

  const { data, error } =
    await supabase
      .from('comment_likes')
      .select('comment_id')
      .eq('user_id', userId)
      .in(
        'comment_id',
        commentIds
      )

  if (error) throw error

  return new Set(
    (data || []).map(
      (item) =>
        String(item.comment_id)
    )
  )
}

function attachReplies(
  parentComments,
  replies
) {
  const replyMap = new Map()

  replies.forEach((reply) => {
    const key = String(
      reply.parent_id || ''
    )
    const current =
      replyMap.get(key) || []

    current.push(reply)
    replyMap.set(key, current)
  })

  return parentComments.map(
    (comment) => ({
      ...comment,
      replies:
        replyMap.get(
          String(comment.id)
        ) || [],
    })
  )
}

async function loadComments({
  storyId,
  episodeId = null,
  page,
  limit,
  sort,
  userId,
}) {
  const from =
    (page - 1) * limit
  const to =
    from + limit - 1

  let query = supabase
    .from('comments')
    .select(
      '*, user:users(id, name, username, avatar_url, role)',
      { count: 'exact' }
    )
    .eq('story_id', storyId)
    .eq('is_hidden', false)
    .is('deleted_at', null)
    .is('parent_id', null)
    .range(from, to)

  if (episodeId) {
    query = query.eq(
      'episode_id',
      episodeId
    )
  }

  if (sort === 'top') {
    query = query
      .order(
        'is_pinned',
        { ascending: false }
      )
      .order(
        'likes',
        { ascending: false }
      )
      .order(
        'created_at',
        { ascending: false }
      )
  } else if (
    sort === 'oldest'
  ) {
    query = query
      .order(
        'is_pinned',
        { ascending: false }
      )
      .order(
        'created_at',
        { ascending: true }
      )
  } else {
    query = query
      .order(
        'is_pinned',
        { ascending: false }
      )
      .order(
        'created_at',
        { ascending: false }
      )
  }

  const {
    data,
    error,
    count,
  } = await query

  if (error) throw error

  let deletedQuery = supabase
    .from('comments')
    .select(
      '*, user:users(id, name, username, avatar_url, role)'
    )
    .eq('story_id', storyId)
    .eq('is_hidden', false)
    .not(
      'deleted_at',
      'is',
      null
    )
    .is('parent_id', null)
    .order(
      'deleted_at',
      { ascending: false }
    )
    .limit(
      Math.min(
        100,
        limit * 5
      )
    )

  if (episodeId) {
    deletedQuery =
      deletedQuery.eq(
        'episode_id',
        episodeId
      )
  }

  let deletedParents = []

  if (page === 1) {
    const {
      data: deletedRows,
      error: deletedError,
    } = await deletedQuery

    if (deletedError) {
      throw deletedError
    }

    deletedParents =
      deletedRows || []
  }

  const candidateParents = [
    ...(data || []),
    ...deletedParents,
  ]
  const candidateIds =
    candidateParents.map(
      (comment) => comment.id
    )

  let replies = []

  if (candidateIds.length) {
    let replyQuery = supabase
      .from('comments')
      .select(
        '*, user:users(id, name, username, avatar_url, role)'
      )
      .eq('story_id', storyId)
      .eq('is_hidden', false)
      .is('deleted_at', null)
      .in(
        'parent_id',
        candidateIds
      )
      .order(
        'created_at',
        { ascending: true }
      )

    if (episodeId) {
      replyQuery =
        replyQuery.eq(
          'episode_id',
          episodeId
        )
    }

    const {
      data: replyData,
      error: replyError,
    } = await replyQuery

    if (replyError) {
      throw replyError
    }

    replies = replyData || []
  }

  const replyParentIds =
    new Set(
      replies.map(
        (reply) =>
          String(
            reply.parent_id || ''
          )
      )
    )
  const visibleDeletedParents =
    deletedParents.filter(
      (comment) =>
        replyParentIds.has(
          String(comment.id)
        )
    )
  const parentRows = [
    ...(data || []),
    ...visibleDeletedParents,
  ]
  const allIds = [
    ...parentRows.map(
      (comment) => comment.id
    ),
    ...replies.map(
      (reply) => reply.id
    ),
  ]
  const likedIds =
    await getLikedIds(
      allIds,
      userId
    )
  const publicParents =
    parentRows.map(
      (comment) =>
        publicComment(
          comment,
          likedIds
        )
    )
  const publicReplies =
    replies.map(
      (reply) =>
        publicComment(
          reply,
          likedIds
        )
    )

  return {
    comments: attachReplies(
      publicParents,
      publicReplies
    ),
    total:
      Number(count || 0),
  }
}

export async function getStoryComments(
  req,
  res
) {
  try {
    const storyId =
      String(
        req.params.storyId || ''
      ).trim()
    const page =
      Math.max(
        1,
        Number(
          req.query.page || 1
        )
      )
    const limit =
      Math.min(
        30,
        Math.max(
          5,
          Number(
            req.query.limit || 20
          )
        )
      )
    const sort =
      String(
        req.query.sort || 'newest'
      )
        .trim()
        .toLowerCase()
    const userId =
      getRequestUserId(req)
    const story =
      await getStory(storyId)

    if (!story) {
      return res.status(404).json({
        ok: false,
        message:
          'Story not found',
      })
    }

    const result =
      await loadComments({
        storyId,
        page,
        limit,
        sort,
        userId,
      })

    return res.status(200).json({
      ok: true,
      comments:
        result.comments,
      page,
      limit,
      total:
        result.total,
      has_more:
        page * limit
        < result.total,
    })
  } catch (error) {
    console.error(
      'GET STORY COMMENTS ERROR:',
      error
    )

    return res.status(500).json({
      ok: false,
      message:
        'Failed to load comments',
      error: error.message,
    })
  }
}

export async function getEpisodeComments(
  req,
  res
) {
  try {
    const episodeId =
      String(
        req.params.episodeId || ''
      ).trim()
    const page =
      Math.max(
        1,
        Number(
          req.query.page || 1
        )
      )
    const limit =
      Math.min(
        30,
        Math.max(
          5,
          Number(
            req.query.limit || 20
          )
        )
      )
    const sort =
      String(
        req.query.sort || 'newest'
      )
        .trim()
        .toLowerCase()
    const userId =
      getRequestUserId(req)
    const episode =
      await getEpisode(episodeId)

    if (!episode) {
      return res.status(404).json({
        ok: false,
        message:
          'Episode not found',
      })
    }

    const result =
      await loadComments({
        storyId:
          episode.story_id,
        episodeId,
        page,
        limit,
        sort,
        userId,
      })

    return res.status(200).json({
      ok: true,
      comments:
        result.comments,
      page,
      limit,
      total:
        result.total,
      has_more:
        page * limit
        < result.total,
    })
  } catch (error) {
    console.error(
      'GET EPISODE COMMENTS ERROR:',
      error
    )

    return res.status(500).json({
      ok: false,
      message:
        'Failed to load episode comments',
      error: error.message,
    })
  }
}

async function createComment({
  story,
  episodeId = null,
  userId,
  text,
  parentId,
}) {
  if (parentId) {
    const parent =
      await getComment(parentId)

    const sameStory =
      parent &&
      String(
        parent.story_id
      ) === String(story.id)
    const sameEpisode =
      episodeId
        ? String(
            parent?.episode_id || ''
          ) === String(episodeId)
        : true

    if (
      !sameStory ||
      !sameEpisode
    ) {
      return {
        errorResponse: {
          status: 400,
          message:
            'Parent comment is not valid',
        },
      }
    }
  }

  const shouldProtect =
    Boolean(story.author_id) &&
    String(story.user_id || '') !==
      String(userId)
  const matchedWords = shouldProtect
    ? await findAuthorBlockedWordsInComment({
        authorPageId: story.author_id,
        authorUserId: story.user_id,
        text,
      })
    : []
  const isAutoHidden =
    matchedWords.length > 0

  const insertData = {
    story_id: story.id,
    user_id: userId,
    parent_id: parentId,
    text,
    is_hidden: isAutoHidden,
  }

  if (episodeId) {
    insertData.episode_id =
      episodeId
  }

  const { data, error } =
    await supabase
      .from('comments')
      .insert(insertData)
      .select(
        '*, user:users(id, name, username, avatar_url, role)'
      )
      .single()

  if (error) throw error

  if (isAutoHidden) {
    try {
      await saveAuthorHiddenCommentReview({
        authorPageId: story.author_id,
        authorUserId: story.user_id,
        commentId: data.id,
        storyId: story.id,
        episodeId,
        readerUserId: userId,
        text,
        matchedWords,
      })
    } catch (reviewError) {
      await supabase
        .from('comments')
        .delete()
        .eq('id', data.id)

      throw reviewError
    }

    return {
      hiddenResponse:
        authorHiddenCommentPayload(
          matchedWords
        ),
    }
  }

  await supabase
    .from('stories')
    .update({
      total_comments:
        Number(
          story.total_comments || 0
        ) + 1,
      updated_at:
        new Date().toISOString(),
    })
    .eq('id', story.id)

  const isOwner =
    String(
      story.user_id || ''
    ) === String(userId)
  const reader =
    publicUser(data.user)

  if (
    !isOwner &&
    story.author_id
  ) {
    const targetUrl =
      episodeId
        ? `/story/${story.id}/episode/${episodeId}?comment=${data.id}`
        : `/story/${story.id}?comment=${data.id}`
    const sourceKey =
      episodeId
        ? `episode-comment:${data.id}`
        : `story-comment:${data.id}`

    await Promise.all([
      incrementAuthorPageAnalytics(
        story.author_id,
        'comments'
      ),
      incrementAuthorPageAnalytics(
        story.author_id,
        'interactions'
      ),
      createAuthorStoryNotificationSafely({
        authorId:
          story.author_id,
        type: 'comment',
        title:
          `${reader.name} ${
            parentId
              ? 'replied on'
              : 'commented on'
          } ${
            story.title
            || 'your story'
          }`,
        message: text,
        targetUrl,
        sourceKey,
        metadata: {
          story_id: story.id,
          episode_id:
            episodeId || null,
          comment_id: data.id,
          parent_id: parentId,
          reader_id: userId,
          reader_name:
            reader.name,
          reader_username:
            reader.username,
          reader_avatar_url:
            reader.avatar_url,
        },
      }),
    ])
  }

  return {
    comment:
      publicComment(data),
  }
}

export async function createStoryComment(
  req,
  res
) {
  try {
    const storyId =
      String(
        req.params.storyId || ''
      ).trim()
    const userId =
      req.user?.user_id
    const text =
      normalizeText(req.body.text)
    const parentId =
      String(
        req.body.parent_id
        || req.body.parentId
        || ''
      ).trim() || null

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    const readerCommentBlock =
      await getActiveReaderCommentBlock(
        userId
      )

    if (readerCommentBlock) {
      return res
        .status(403)
        .json(
          readerCommentBlockedPayload(
            readerCommentBlock
          )
        )
    }

    if (!text) {
      return res.status(400).json({
        ok: false,
        message:
          'Comment text is required',
      })
    }

    const story =
      await getStory(storyId)

    if (!story) {
      return res.status(404).json({
        ok: false,
        message:
          'Story not found',
      })
    }

    const storyBan =
      await getActiveStoryCommentBan(
        storyId,
        userId
      )

    if (storyBan) {
      return sendStoryBanResponse(
        res,
        storyBan
      )
    }

    const result =
      await createComment({
        story,
        userId,
        text,
        parentId,
      })

    if (result.errorResponse) {
      return res
        .status(
          result.errorResponse.status
        )
        .json({
          ok: false,
          message:
            result.errorResponse
              .message,
        })
    }

    if (result.hiddenResponse) {
      return res.status(202).json(
        result.hiddenResponse
      )
    }

    return res.status(201).json({
      ok: true,
      comment:
        result.comment,
    })
  } catch (error) {
    console.error(
      'CREATE STORY COMMENT ERROR:',
      error
    )

    return res.status(500).json({
      ok: false,
      message:
        'Failed to create comment',
      error: error.message,
    })
  }
}

export async function createEpisodeComment(
  req,
  res
) {
  try {
    const episodeId =
      String(
        req.params.episodeId || ''
      ).trim()
    const userId =
      req.user?.user_id
    const text =
      normalizeText(req.body.text)
    const parentId =
      String(
        req.body.parent_id
        || req.body.parentId
        || ''
      ).trim() || null

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    const readerCommentBlock =
      await getActiveReaderCommentBlock(
        userId
      )

    if (readerCommentBlock) {
      return res
        .status(403)
        .json(
          readerCommentBlockedPayload(
            readerCommentBlock
          )
        )
    }

    if (!text) {
      return res.status(400).json({
        ok: false,
        message:
          'Comment text is required',
      })
    }

    const episode =
      await getEpisode(episodeId)

    if (!episode) {
      return res.status(404).json({
        ok: false,
        message:
          'Episode not found',
      })
    }

    const story =
      await getStory(
        episode.story_id
      )

    if (!story) {
      return res.status(404).json({
        ok: false,
        message:
          'Story not found',
      })
    }

    const storyBan =
      await getActiveStoryCommentBan(
        episode.story_id,
        userId
      )

    if (storyBan) {
      return sendStoryBanResponse(
        res,
        storyBan
      )
    }

    const result =
      await createComment({
        story,
        episodeId,
        userId,
        text,
        parentId,
      })

    if (result.errorResponse) {
      return res
        .status(
          result.errorResponse.status
        )
        .json({
          ok: false,
          message:
            result.errorResponse
              .message,
        })
    }

    if (result.hiddenResponse) {
      return res.status(202).json(
        result.hiddenResponse
      )
    }

    return res.status(201).json({
      ok: true,
      comment:
        result.comment,
    })
  } catch (error) {
    console.error(
      'CREATE EPISODE COMMENT ERROR:',
      error
    )

    return res.status(500).json({
      ok: false,
      message:
        'Failed to create episode comment',
      error: error.message,
    })
  }
}

export async function toggleCommentLike(
  req,
  res
) {
  try {
    const commentId =
      String(
        req.params.commentId || ''
      ).trim()
    const userId =
      req.user?.user_id

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    const comment =
      await getComment(commentId)

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
      error: lookupError,
    } = await supabase
      .from('comment_likes')
      .select('id')
      .eq(
        'comment_id',
        commentId
      )
      .eq('user_id', userId)
      .maybeSingle()

    if (lookupError) {
      throw lookupError
    }

    let liked = false

    if (existingLike?.id) {
      const { error } =
        await supabase
          .from(
            'comment_likes'
          )
          .delete()
          .eq(
            'id',
            existingLike.id
          )

      if (error) throw error
    } else {
      const { error } =
        await supabase
          .from(
            'comment_likes'
          )
          .insert({
            comment_id:
              commentId,
            user_id: userId,
          })

      if (error) throw error

      liked = true
    }

    const {
      count,
      error: countError,
    } = await supabase
      .from('comment_likes')
      .select(
        'id',
        {
          count: 'exact',
          head: true,
        }
      )
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
        .from('comments')
        .update({
          likes,
          updated_at:
            new Date().toISOString(),
        })
        .eq('id', commentId)
        .is(
          'deleted_at',
          null
        )

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
      'TOGGLE COMMENT LIKE ERROR:',
      error
    )

    return res.status(500).json({
      ok: false,
      message:
        'Failed to update like',
      error: error.message,
    })
  }
}

export async function updateOwnComment(
  req,
  res
) {
  try {
    const commentId =
      String(
        req.params.commentId || ''
      ).trim()
    const userId =
      req.user?.user_id
    const text =
      normalizeText(req.body.text)

    if (!text) {
      return res.status(400).json({
        ok: false,
        message:
          'Comment text is required',
      })
    }

    const comment =
      await getComment(commentId)

    if (!comment) {
      return res.status(404).json({
        ok: false,
        message:
          'Comment not found',
      })
    }

    if (
      String(comment.user_id)
      !== String(userId)
    ) {
      return res.status(403).json({
        ok: false,
        message:
          'You can only edit your own comment',
      })
    }

    const { data, error } =
      await supabase
        .from('comments')
        .update({
          text,
          updated_at:
            new Date().toISOString(),
        })
        .eq('id', commentId)
        .is(
          'deleted_at',
          null
        )
        .select(
          '*, user:users(id, name, username, avatar_url, role)'
        )
        .single()

    if (error) throw error

    const updatedComment =
      await getPublicComment(
        data.id,
        userId
      )

    return res.status(200).json({
      ok: true,
      comment:
        updatedComment
        || publicComment(data),
    })
  } catch (error) {
    console.error(
      'UPDATE OWN COMMENT ERROR:',
      error
    )

    return res.status(500).json({
      ok: false,
      message:
        'Failed to update comment',
      error: error.message,
    })
  }
}

export async function moderateComment(
  req,
  res
) {
  try {
    const commentId =
      String(
        req.params.commentId || ''
      ).trim()
    const userId =
      req.user?.user_id
    const action =
      String(
        req.body.action || ''
      )
        .trim()
        .toLowerCase()

    const comment =
      await getComment(commentId)

    if (!comment) {
      return res.status(404).json({
        ok: false,
        message:
          'Comment not found',
      })
    }

    const permission =
      await canModerateStory(
        comment.story_id,
        userId
      )
    const ownsComment =
      comment.user_id &&
      userId &&
      String(
        comment.user_id
      ) === String(userId)

    if (action === 'delete') {
      if (
        !ownsComment &&
        !permission.ok
      ) {
        return res.status(403).json({
          ok: false,
          message:
            'You cannot delete this comment',
        })
      }

      const actorType =
        ownsComment
          ? 'reader'
          : permission.isAdmin
            ? 'admin'
            : 'author'

      const result =
        await deleteStoryCommentToTrash({
          commentId,
          actorType,
          actorId:
            String(userId),
          reason:
            normalizeText(
              req.body.reason
            ),
        })

      if (!result.ok) {
        const status =
          getCommentTrashStatus(
            result
          )

        if (
          result.retry_after_seconds
        ) {
          res.setHeader(
            'Retry-After',
            String(
              result.retry_after_seconds
            )
          )
        }

        return res
          .status(status)
          .json({
            ok: false,
            code: result.code,
            message:
              getCommentTrashMessage(
                result
              ),
            limit:
              result.limit ?? null,
            used:
              result.used ?? null,
            remaining:
              result.remaining
              ?? null,
            retry_after_seconds:
              result.retry_after_seconds
              ?? 0,
          })
      }

      return res.status(200).json({
        ok: true,
        message:
          'Comment moved to trash',
        comment_id:
          result.comment_id,
        deleted_at:
          result.deleted_at,
        delete_expires_at:
          result.delete_expires_at,
        limit:
          result.limit ?? null,
        used:
          result.used ?? null,
        remaining:
          result.remaining ?? null,
      })
    }

    if (!permission.ok) {
      return res.status(403).json({
        ok: false,
        message:
          'You cannot moderate this comment',
      })
    }

    if (action === 'ban') {
      if (!comment.user_id) {
        return res.status(400).json({
          ok: false,
          message:
            'Comment user is not available',
        })
      }

      const requestedDuration =
        normalizeText(
          req.body.duration
        ) || '24h'

      if (
        !COMMENT_BAN_DURATIONS[
          requestedDuration
        ]
      ) {
        return res.status(400).json({
          ok: false,
          message:
            'Invalid restriction duration',
        })
      }

      const {
        duration,
        expiresAt,
      } = durationToExpiresAt(
        requestedDuration
      )
      const reason =
        normalizeText(
          req.body.reason
        )

      const { error } =
        await supabase
          .from('comment_bans')
          .upsert({
            story_id:
              comment.story_id,
            user_id:
              comment.user_id,
            banned_by_user_id:
              userId,
            reason:
              encodeBanReason(
                reason,
                expiresAt
              ),
          }, {
            onConflict:
              'story_id,user_id',
          })

      if (error) throw error

      return res.status(200).json({
        ok: true,
        message:
          `User restricted from commenting for ${duration}`,
        duration,
        restriction_until:
          expiresAt,
      })
    }

    const updateData = {
      updated_at:
        new Date().toISOString(),
    }

    if (action === 'hide') {
      updateData.is_hidden = true
    }
    if (action === 'unhide') {
      updateData.is_hidden = false
    }
    if (action === 'pin') {
      updateData.is_pinned = true
    }
    if (action === 'unpin') {
      updateData.is_pinned = false
    }
    if (action === 'spoiler') {
      updateData.is_spoiler = true
    }
    if (action === 'unspoiler') {
      updateData.is_spoiler = false
    }

    if (
      Object.keys(
        updateData
      ).length <= 1
    ) {
      return res.status(400).json({
        ok: false,
        message:
          'Action is not valid',
      })
    }

    const { data, error } =
      await supabase
        .from('comments')
        .update(updateData)
        .eq('id', commentId)
        .is(
          'deleted_at',
          null
        )
        .select(
          '*, user:users(id, name, username, avatar_url, role)'
        )
        .single()

    if (error) throw error

    const updatedComment =
      await getPublicComment(
        data.id,
        userId
      )

    return res.status(200).json({
      ok: true,
      comment:
        updatedComment
        || publicComment(data),
    })
  } catch (error) {
    console.error(
      'MODERATE COMMENT ERROR:',
      error
    )

    return res.status(500).json({
      ok: false,
      message:
        'Failed to moderate comment',
      error: error.message,
    })
  }
}

async function fetchStoryMap(
  storyIds
) {
  const ids = [
    ...new Set(
      (storyIds || [])
        .filter(Boolean)
    ),
  ]

  if (!ids.length) {
    return new Map()
  }

  const { data, error } =
    await supabase
      .from('stories')
      .select(
        'id, title, cover_url'
      )
      .in('id', ids)

  if (error) throw error

  return new Map(
    (data || []).map(
      (story) => [
        story.id,
        story,
      ]
    )
  )
}

function publicMyCommentActivity(
  comment,
  storyMap,
  type
) {
  const story =
    storyMap.get(
      comment.story_id
    ) || null

  return {
    id: comment.id,
    activity_type: type,
    story_id:
      comment.story_id,
    parent_id:
      comment.parent_id,
    text: comment.text,
    message: comment.text,
    link:
      `/story/${comment.story_id}`,
    is_hidden:
      Boolean(
        comment.is_hidden
      ),
    is_read: true,
    notification_id: null,
    created_at:
      comment.created_at,
    updated_at:
      comment.updated_at,
    story,
  }
}

export async function getMyCommentActivities(
  req,
  res
) {
  try {
    const userId =
      req.user?.user_id
    const filter =
      String(
        req.query.filter || 'mine'
      )
        .trim()
        .toLowerCase()

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    const {
      data: user,
      error: userError,
    } = await supabase
      .from('users')
      .select(
        'id, username, name'
      )
      .eq('id', userId)
      .maybeSingle()

    if (userError) {
      throw userError
    }

    let activities = []

    if (filter === 'replies') {
      const {
        data: parents,
        error: parentError,
      } = await supabase
        .from('comments')
        .select('id')
        .eq('user_id', userId)
        .eq(
          'is_hidden',
          false
        )
        .is(
          'deleted_at',
          null
        )
        .limit(300)

      if (parentError) {
        throw parentError
      }

      const parentIds =
        (parents || []).map(
          (item) => item.id
        )

      if (parentIds.length) {
        const {
          data,
          error,
        } = await supabase
          .from('comments')
          .select(
            'id, story_id, user_id, parent_id, text, is_hidden, created_at, updated_at'
          )
          .in(
            'parent_id',
            parentIds
          )
          .neq(
            'user_id',
            userId
          )
          .eq(
            'is_hidden',
            false
          )
          .is(
            'deleted_at',
            null
          )
          .order(
            'created_at',
            { ascending: false }
          )
          .limit(80)

        if (error) throw error

        activities = data || []
      }
    } else if (
      filter === 'mentions'
    ) {
      const username =
        String(
          user?.username || ''
        ).trim()

      if (username) {
        const {
          data,
          error,
        } = await supabase
          .from('comments')
          .select(
            'id, story_id, user_id, parent_id, text, is_hidden, created_at, updated_at'
          )
          .ilike(
            'text',
            `%@${username}%`
          )
          .neq(
            'user_id',
            userId
          )
          .eq(
            'is_hidden',
            false
          )
          .is(
            'deleted_at',
            null
          )
          .order(
            'created_at',
            { ascending: false }
          )
          .limit(80)

        if (error) throw error

        activities = data || []
      }
    } else {
      const {
        data,
        error,
      } = await supabase
        .from('comments')
        .select(
          'id, story_id, user_id, parent_id, text, is_hidden, created_at, updated_at'
        )
        .eq('user_id', userId)
        .eq(
          'is_hidden',
          false
        )
        .is(
          'deleted_at',
          null
        )
        .order(
          'created_at',
          { ascending: false }
        )
        .limit(80)

      if (error) throw error

      activities = data || []
    }

    const storyMap =
      await fetchStoryMap(
        activities.map(
          (item) =>
            item.story_id
        )
      )
    const activityType =
      filter === 'mine'
      || filter === 'all'
        ? 'mine'
        : filter.endsWith('s')
          ? filter.slice(0, -1)
          : filter

    return res.status(200).json({
      ok: true,
      filter,
      activities:
        activities.map(
          (item) =>
            publicMyCommentActivity(
              item,
              storyMap,
              activityType
            )
        ),
      counts: {
        all:
          filter === 'all'
            ? activities.length
            : 0,
        mine:
          filter === 'mine'
            ? activities.length
            : 0,
        replies:
          filter === 'replies'
            ? activities.length
            : 0,
        mentions:
          filter === 'mentions'
            ? activities.length
            : 0,
      },
    })
  } catch (error) {
    console.error(
      'GET MY COMMENT ACTIVITIES ERROR:',
      error
    )

    return res.status(500).json({
      ok: false,
      message:
        'Failed to load comment activity',
      error: error.message,
    })
  }
}
