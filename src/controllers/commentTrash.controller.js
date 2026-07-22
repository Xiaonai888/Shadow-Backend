import { supabase } from '../config/supabase.js'
import {
  getCommentTrashMessage,
  getCommentTrashStatus,
  recoverAuthorPageCommentFromTrash,
  recoverStoryCommentFromTrash,
} from '../services/commentTrash.service.js'

const SOURCES = new Set(['story', 'author_page'])
const MAX_LIMIT = 100
const MAX_FETCH = 500

function normalizeText(value) {
  return String(value || '').trim()
}

function normalizePage(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0
    ? Math.floor(number)
    : 1
}

function normalizeLimit(value) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return 30
  return Math.min(Math.floor(number), MAX_LIMIT)
}

function relation(value) {
  return Array.isArray(value) ? value[0] || null : value || null
}

function publicUser(value) {
  const user = relation(value)

  return {
    id: user?.id || null,
    name: user?.name || user?.username || 'Reader',
    username: user?.username || '',
    avatar_url: user?.avatar_url || '',
    role: user?.role || 'reader',
  }
}

function expiresInSeconds(value) {
  const milliseconds = new Date(value).getTime() - Date.now()
  return Math.max(0, Math.ceil(milliseconds / 1000))
}

function canAuthorRecover(row, actorId) {
  return (
    row.deleted_by_type === 'author' &&
    String(row.deleted_by_id || '') === String(actorId || '')
  )
}

function storyTrashItem(row, actorId, isAdmin) {
  const story = relation(row.story)

  return {
    source: 'story',
    comment_id: row.id,
    content_type: row.episode_id ? 'episode' : 'story',
    story_id: row.story_id,
    episode_id: row.episode_id || null,
    post_id: null,
    parent_id: row.parent_id || null,
    text: row.text || '',
    user: publicUser(row.user),
    context: {
      title: story?.title || 'Untitled Story',
      cover_url: story?.cover_url || '',
    },
    deleted_at: row.deleted_at,
    delete_expires_at: row.delete_expires_at,
    expires_in_seconds: expiresInSeconds(row.delete_expires_at),
    deleted_by_type: row.deleted_by_type || '',
    deleted_by_id: row.deleted_by_id || '',
    delete_reason: row.delete_reason || '',
    can_recover: isAdmin || canAuthorRecover(row, actorId),
  }
}

function authorPageTrashItem(row, postMap, actorId, isAdmin) {
  const post = postMap.get(String(row.post_id)) || null

  return {
    source: 'author_page',
    comment_id: row.id,
    content_type: 'author_post',
    story_id: null,
    episode_id: null,
    post_id: row.post_id,
    parent_id: row.parent_id || null,
    text: row.text || '',
    user: publicUser(row.user),
    context: {
      author_page_id: post?.author_page_id || null,
      post_excerpt: normalizeText(post?.content).slice(0, 160),
    },
    deleted_at: row.deleted_at,
    delete_expires_at: row.delete_expires_at,
    expires_in_seconds: expiresInSeconds(row.delete_expires_at),
    deleted_by_type: row.deleted_by_type || '',
    deleted_by_id: row.deleted_by_id || '',
    delete_reason: row.delete_reason || '',
    can_recover: isAdmin || canAuthorRecover(row, actorId),
  }
}

async function loadTrash({
  actorId,
  ownerUserId = null,
  page,
  limit,
  isAdmin,
}) {
  const now = new Date().toISOString()
  const fetchLimit = Math.min(page * limit, MAX_FETCH)

  let storyQuery = supabase
    .from('comments')
    .select(
      'id, story_id, episode_id, user_id, parent_id, text, deleted_at, delete_expires_at, deleted_by_type, deleted_by_id, delete_reason, user:users(id, name, username, avatar_url, role), story:stories(id, title, cover_url)',
      { count: 'exact' }
    )
    .not('deleted_at', 'is', null)
    .gt('delete_expires_at', now)
    .order('deleted_at', { ascending: false })
    .limit(fetchLimit)

  let authorPageQuery = supabase
    .from('author_page_post_comments')
    .select(
      'id, post_id, user_id, parent_id, text, deleted_at, delete_expires_at, deleted_by_type, deleted_by_id, delete_reason, user:users(id, name, username, avatar_url, role)',
      { count: 'exact' }
    )
    .not('deleted_at', 'is', null)
    .gt('delete_expires_at', now)
    .order('deleted_at', { ascending: false })
    .limit(fetchLimit)

  if (ownerUserId) {
    storyQuery = storyQuery.eq('trash_owner_user_id', ownerUserId)
    authorPageQuery = authorPageQuery.eq(
      'trash_owner_user_id',
      ownerUserId
    )
  }

  const [
    { data: storyRows, error: storyError, count: storyCount },
    {
      data: authorPageRows,
      error: authorPageError,
      count: authorPageCount,
    },
  ] = await Promise.all([storyQuery, authorPageQuery])

  if (storyError) throw storyError
  if (authorPageError) throw authorPageError

  const postIds = [
    ...new Set(
      (authorPageRows || [])
        .map((row) => row.post_id)
        .filter(Boolean)
    ),
  ]

  let postMap = new Map()

  if (postIds.length) {
    const { data: posts, error: postsError } = await supabase
      .from('author_page_posts')
      .select('id, author_page_id, user_id, content')
      .in('id', postIds)

    if (postsError) throw postsError

    postMap = new Map(
      (posts || []).map((post) => [String(post.id), post])
    )
  }

  const items = [
    ...(storyRows || []).map((row) =>
      storyTrashItem(row, actorId, isAdmin)
    ),
    ...(authorPageRows || []).map((row) =>
      authorPageTrashItem(row, postMap, actorId, isAdmin)
    ),
  ].sort(
    (left, right) =>
      new Date(right.deleted_at).getTime() -
      new Date(left.deleted_at).getTime()
  )

  const from = (page - 1) * limit
  const total =
    Number(storyCount || 0) + Number(authorPageCount || 0)

  return {
    items: items.slice(from, from + limit),
    total,
    has_more: page * limit < total,
  }
}

function recoveryStatus(result) {
  if (result?.code === 'COMMENT_RECOVERY_EXPIRED') return 410
  return getCommentTrashStatus(result)
}

function recoveryMessage(result) {
  if (result?.code === 'COMMENT_RECOVERY_EXPIRED') {
    return 'Comment recovery period has expired'
  }

  return getCommentTrashMessage(result, 'recover')
}

async function recoverComment({
  source,
  commentId,
  actorType,
  actorId,
}) {
  if (source === 'story') {
    return recoverStoryCommentFromTrash({
      commentId,
      actorType,
      actorId,
    })
  }

  return recoverAuthorPageCommentFromTrash({
    commentId,
    actorType,
    actorId,
  })
}

export async function getMyAuthorCommentTrash(req, res) {
  try {
    const userId = normalizeText(req.user?.user_id)
    const page = normalizePage(req.query.page)
    const limit = normalizeLimit(req.query.limit)

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    const result = await loadTrash({
      actorId: userId,
      ownerUserId: userId,
      page,
      limit,
      isAdmin: false,
    })

    return res.status(200).json({
      ok: true,
      page,
      limit,
      ...result,
    })
  } catch (error) {
    console.error('GET AUTHOR COMMENT TRASH ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load comment trash',
      error: error.message,
    })
  }
}

export async function recoverMyAuthorTrashComment(req, res) {
  try {
    const userId = normalizeText(req.user?.user_id)
    const source = normalizeText(req.params.source).toLowerCase()
    const commentId = normalizeText(req.params.commentId)

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    if (!SOURCES.has(source) || !commentId) {
      return res.status(400).json({
        ok: false,
        message: 'Invalid trash comment',
      })
    }

    const result = await recoverComment({
      source,
      commentId,
      actorType: 'author',
      actorId: userId,
    })

    if (!result.ok) {
      return res.status(recoveryStatus(result)).json({
        ok: false,
        code: result.code,
        message: recoveryMessage(result),
      })
    }

    return res.status(200).json({
      ok: true,
      message: 'Comment recovered',
      comment_id: result.comment_id,
      recovered_at: result.recovered_at,
    })
  } catch (error) {
    console.error('RECOVER AUTHOR TRASH COMMENT ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to recover comment',
      error: error.message,
    })
  }
}

export async function getAdminCommentTrash(req, res) {
  try {
    const adminId = normalizeText(
      req.admin?.admin_id || req.admin?.id
    )
    const page = normalizePage(req.query.page)
    const limit = normalizeLimit(req.query.limit)

    if (!adminId) {
      return res.status(401).json({
        ok: false,
        message: 'Admin account id is missing',
      })
    }

    const result = await loadTrash({
      actorId: adminId,
      page,
      limit,
      isAdmin: true,
    })

    return res.status(200).json({
      ok: true,
      page,
      limit,
      ...result,
    })
  } catch (error) {
    console.error('GET ADMIN COMMENT TRASH ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load admin comment trash',
      error: error.message,
    })
  }
}

export async function recoverAdminTrashComment(req, res) {
  try {
    const adminId = normalizeText(
      req.admin?.admin_id || req.admin?.id
    )
    const source = normalizeText(req.params.source).toLowerCase()
    const commentId = normalizeText(req.params.commentId)

    if (!adminId) {
      return res.status(401).json({
        ok: false,
        message: 'Admin account id is missing',
      })
    }

    if (!SOURCES.has(source) || !commentId) {
      return res.status(400).json({
        ok: false,
        message: 'Invalid trash comment',
      })
    }

    const result = await recoverComment({
      source,
      commentId,
      actorType: 'admin',
      actorId: adminId,
    })

    if (!result.ok) {
      return res.status(recoveryStatus(result)).json({
        ok: false,
        code: result.code,
        message: recoveryMessage(result),
      })
    }

    return res.status(200).json({
      ok: true,
      message: 'Comment recovered',
      comment_id: result.comment_id,
      recovered_at: result.recovered_at,
    })
  } catch (error) {
    console.error('RECOVER ADMIN TRASH COMMENT ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to recover comment',
      error: error.message,
    })
  }
}
