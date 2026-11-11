import jwt from 'jsonwebtoken'
import { supabase } from '../config/supabase.js'
import { createAuthorPageNotification } from './authorPageNotifications.controller.js'
import { publishAuthorPageNotificationCreated } from '../services/authorPageNotificationSse.service.js'

// Isolated Fast Reel comments. Never write to the Story/Post comments tables.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const COMMENT_FIELDS = 'id,video_id,user_id,parent_id,body,likes_count,reply_count,created_at,updated_at,deleted_at,user:users!fast_video_comments_user_id_fkey(id,name,username,avatar_url,role)'
const MAX_BODY = 1000
const SORT_OPTIONS = new Set(['top', 'newest', 'all'])

const validId = value => typeof value === 'string' && UUID.test(value)
const trimBody = value => typeof value === 'string' ? value.trim() : ''

function optionalReaderId(req) {
  try {
    const header = String(req.headers.authorization || '')
    if (!header.startsWith('Bearer ')) return null
    const payload = jwt.verify(header.slice(7), process.env.JWT_SECRET)
    return payload.type === 'reader' && validId(payload.user_id) ? payload.user_id : null
  } catch { return null }
}

async function publishedReel(videoId) {
  const { data, error } = await supabase.from('fast_videos')
    .select('id,user_id').eq('id', videoId)
    .eq('status', 'published').eq('access_type', 'free')
    .eq('platform', 'youtube').maybeSingle()
  if (error) throw error
  return data
}

async function visibleCount(videoId) {
  const { count, error } = await supabase.from('fast_video_comments')
    .select('id', { count: 'exact', head: true })
    .eq('video_id', videoId).is('deleted_at', null)
  if (error) throw error
  return Number(count ?? 0)
}

async function findComment(videoId, commentId) {
  const { data, error } = await supabase.from('fast_video_comments')
    .select(COMMENT_FIELDS).eq('video_id', videoId).eq('id', commentId).maybeSingle()
  if (error) throw error
  return data
}

async function readerLikes(commentIds, readerId) {
  if (!readerId || !commentIds.length) return new Set()
  const { data, error } = await supabase.from('fast_video_comment_likes')
    .select('comment_id').eq('user_id', readerId).in('comment_id', commentIds)
  if (error) throw error
  return new Set((data || []).map(row => row.comment_id))
}

function publicComment(row, likedIds, readerId) {
  const deleted = Boolean(row.deleted_at)
  const user = Array.isArray(row.user) ? row.user[0] : row.user
  return {
    id: row.id,
    video_id: row.video_id,
    parent_id: row.parent_id,
    body: deleted ? '' : row.body,
    is_deleted: deleted,
    user: deleted ? null : user ? {
      id: user.id, name: user.name || user.username || 'Reader',
      username: user.username || '', avatar_url: user.avatar_url || '',
      role: user.role || 'reader',
    } : { name: 'Reader', username: '', avatar_url: '' },
    can_edit: !deleted && Boolean(readerId && row.user_id === readerId),
    likes: deleted ? 0 : Math.max(0, Number(row.likes_count || 0)),
    liked: !deleted && Boolean(likedIds?.has(row.id)),
    reply_count: Math.max(0, Number(row.reply_count || 0)),
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

function sendError(res, error, action) {
  const diagnostic = {
    action,
    code: error?.code || 'UNKNOWN',
    message: error?.message || 'Unknown database error',
    details: error?.details || null,
    hint: error?.hint || null,
    status: error?.status || 500,
  }

  console.error(`[FAST_COMMENTS_${action}_ERROR] ${JSON.stringify(diagnostic)}`)

  if (error?.code === '23503') {
    return res.status(404).json({ ok: false, message: 'Reel or comment not found' })
  }
  if (error?.code === '23514' || error?.code === 'P0001') {
    return res.status(400).json({ ok: false, message: 'Invalid Reel comment' })
  }
  if (error?.code === '42P01') {
    return res.status(503).json({ ok: false, message: 'Fast comments migration is not installed' })
  }
  return res.status(500).json({
    ok: false,
    message: 'Fast comments are temporarily unavailable',
    error_code: diagnostic.code,
  })
}

export async function listFastComments(req, res) {
  const videoId = String(req.params.id || '')
  const rawParent = req.query.parent_id
  const parentId = rawParent ? String(rawParent) : null
  const limit = req.query.limit === undefined ? 20 : Number(req.query.limit)
  const offset = req.query.offset === undefined ? 0 : Number(req.query.offset)
  const sort = req.query.sort === undefined ? 'newest' : String(req.query.sort)
  if (!validId(videoId) || (parentId && !validId(parentId)) ||
      !Number.isSafeInteger(limit) || limit < 1 || limit > 30 ||
      !Number.isSafeInteger(offset) || offset < 0 || offset > 5000 ||
      !SORT_OPTIONS.has(sort)) {
    return res.status(400).json({ ok: false, message: 'Invalid Reel comment query' })
  }
  try {
    const reel = await publishedReel(videoId)
    if (!reel) return res.status(404).json({ ok: false, message: 'Reel not found' })
    const readerId = optionalReaderId(req)
    let query = supabase.from('fast_video_comments').select(COMMENT_FIELDS, { count: 'exact' })
      .eq('video_id', videoId)
    if (parentId) {
      const parent = await findComment(videoId, parentId)
      if (!parent || parent.parent_id) return res.status(404).json({ ok: false, message: 'Parent comment not found' })
      query = query.eq('parent_id', parentId).is('deleted_at', null)
        .order('created_at', { ascending: true }).order('id', { ascending: true })
    } else {
      // Deleted parents with visible replies remain as placeholders so replies stay accessible.
      query = query.is('parent_id', null).or('deleted_at.is.null,reply_count.gt.0')
      if (sort === 'top') {
        // Sort in the DB before pagination: a local page-only sort misses older popular comments.
        query = query.order('likes_count', { ascending: false })
          .order('reply_count', { ascending: false })
      }
      // Both Newest and All show the full root set, newest first, like Reader Post.
      query = query.order('created_at', { ascending: false }).order('id', { ascending: false })
    }
    const [{ data, error, count }, commentCount] = await Promise.all([
      query.range(offset, offset + limit), visibleCount(videoId),
    ])
    if (error) throw error
    const rows = (data || []).slice(0, limit)
    const likedIds = await readerLikes(rows.filter(row => !row.deleted_at).map(row => row.id), readerId)
    res.set('Cache-Control', 'private, no-store')
    return res.json({
      ok: true, video_id: videoId, comments: rows.map(row => publicComment(row, likedIds, readerId)),
      comment_count: commentCount,
      pagination: { limit, offset, next_offset: offset + rows.length, has_more: (count || 0) > offset + rows.length },
    })
  } catch (error) { return sendError(res, error, 'LIST') }
}

export async function createFastComment(req, res) {
  const videoId = String(req.params.id || '')
  const userId = req.user?.user_id
  const body = trimBody(req.body?.body)
  const parentId = req.body?.parent_id || null
  if (!validId(videoId) || !validId(userId)) return res.status(400).json({ ok: false, message: 'Invalid Reel or user ID' })
  if (!body || body.length > MAX_BODY) return res.status(400).json({ ok: false, message: 'Comment must be 1–1000 characters' })
  if (parentId && !validId(parentId)) return res.status(400).json({ ok: false, message: 'Invalid reply ID' })
  try {
    const reel = await publishedReel(videoId)
    if (!reel) return res.status(404).json({ ok: false, message: 'Reel not found' })
    if (parentId) {
      const parent = await findComment(videoId, parentId)
      if (!parent || parent.deleted_at || parent.parent_id) {
        return res.status(400).json({ ok: false, message: 'Cannot reply to this comment' })
      }
    }
    const { data, error } = await supabase.from('fast_video_comments')
      .insert({ video_id: videoId, user_id: userId, parent_id: parentId, body })
      .select('id').single()
    if (error) throw error
    const [comment, commentCount] = await Promise.all([findComment(videoId, data.id), visibleCount(videoId)])

if (reel.user_id && reel.user_id !== userId) {
  try {
    const { data: authorPage, error: pageError } = await supabase
      .from('author_pages')
      .select('id')
      .eq('user_id', reel.user_id)
      .eq('status', 'active')
      .maybeSingle()

    if (pageError) throw pageError

    if (authorPage) {
      const actor = Array.isArray(comment?.user) ? comment.user[0] : comment?.user
      const actorName = String(actor?.name || actor?.username || 'Reader').slice(0, 80)

      const notification = await createAuthorPageNotification({
        authorPageId: authorPage.id,
        userId: reel.user_id,
        type: 'comment',
        title: 'New comment on your Reel',
        message: body.slice(0, 180),
        targetUrl: `/author/reel/studio/videos/${videoId}/analytics?section=engagement`,
        metadata: {
          source: 'fast_reel',
          notification_type: 'comment',
          video_id: videoId,
          comment_id: data.id,
          actor_id: userId,
          actor_name: actorName,
          actor_username: actor?.username || '',
          actor_avatar_url: actor?.avatar_url || '',
        },
      })

      if (notification) {
        publishAuthorPageNotificationCreated({
          userId: reel.user_id,
          notification,
        })
      }
    }
  } catch (error) {
    console.error('FAST_REEL_NOTIFICATION_ERROR', error)
  }
}

res.set('Cache-Control', 'no-store')
    return res.status(201).json({ ok: true, comment: publicComment(comment, new Set(), userId), comment_count: commentCount })
  } catch (error) { return sendError(res, error, 'CREATE') }
}

export async function updateFastComment(req, res) {
  const videoId = String(req.params.id || '')
  const commentId = String(req.params.commentId || '')
  const userId = req.user?.user_id
  const body = trimBody(req.body?.body)
  if (!validId(videoId) || !validId(commentId) || !validId(userId)) return res.status(400).json({ ok: false, message: 'Invalid comment ID' })
  if (!body || body.length > MAX_BODY) return res.status(400).json({ ok: false, message: 'Comment must be 1–1000 characters' })
  try {
    const { data, error } = await supabase.from('fast_video_comments')
      .update({ body }).eq('video_id', videoId).eq('id', commentId)
      .eq('user_id', userId).is('deleted_at', null).select('id').maybeSingle()
    if (error) throw error
    if (!data) return res.status(404).json({ ok: false, message: 'Comment not found or not owned by you' })
    const comment = await findComment(videoId, commentId)
    const likedIds = await readerLikes([commentId], userId)
    return res.json({ ok: true, comment: publicComment(comment, likedIds, userId) })
  } catch (error) { return sendError(res, error, 'UPDATE') }
}

export async function deleteFastComment(req, res) {
  const videoId = String(req.params.id || '')
  const commentId = String(req.params.commentId || '')
  const userId = req.user?.user_id
  if (!validId(videoId) || !validId(commentId) || !validId(userId)) return res.status(400).json({ ok: false, message: 'Invalid comment ID' })
  try {
    const { data, error } = await supabase.from('fast_video_comments')
      .update({ deleted_at: new Date().toISOString() }).eq('video_id', videoId)
      .eq('id', commentId).eq('user_id', userId).is('deleted_at', null)
      .select('id').maybeSingle()
    if (error) throw error
    if (!data) return res.status(404).json({ ok: false, message: 'Comment not found or not owned by you' })
    return res.json({ ok: true, deleted: true, comment_count: await visibleCount(videoId) })
  } catch (error) { return sendError(res, error, 'DELETE') }
}

export async function setFastCommentLike(req, res) {
  const videoId = String(req.params.id || '')
  const commentId = String(req.params.commentId || '')
  const userId = req.user?.user_id
  const liked = req.body?.liked
  if (!validId(videoId) || !validId(commentId) || !validId(userId) || typeof liked !== 'boolean') {
    return res.status(400).json({ ok: false, message: 'Invalid comment Like request' })
  }
  try {
    const reel = await publishedReel(videoId)
    if (!reel) return res.status(404).json({ ok: false, message: 'Reel not found' })
    const comment = await findComment(videoId, commentId)
    if (!comment || comment.deleted_at) return res.status(404).json({ ok: false, message: 'Comment not found' })
    if (liked) {
      const { error } = await supabase.from('fast_video_comment_likes')
        .upsert({ comment_id: commentId, user_id: userId },
          { onConflict: 'comment_id,user_id', ignoreDuplicates: true })
      if (error) throw error
    } else {
      const { error } = await supabase.from('fast_video_comment_likes')
        .delete().eq('comment_id', commentId).eq('user_id', userId)
      if (error) throw error
    }
    const [fresh, likedIds] = await Promise.all([findComment(videoId, commentId), readerLikes([commentId], userId)])
    return res.json({ ok: true, comment: publicComment(fresh, likedIds, userId) })
  } catch (error) { return sendError(res, error, 'LIKE') }
}
