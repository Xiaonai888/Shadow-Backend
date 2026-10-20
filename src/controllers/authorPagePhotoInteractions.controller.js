import { createHash } from 'node:crypto'
import jwt from 'jsonwebtoken'
import { supabase } from '../config/supabase.js'
import {
  authorReaderBlockedPayload,
  getActiveAuthorReaderBlock,
} from '../utils/authorReaderCommentBlocks.js'

const REACTION_TYPES = new Set([
  'love',
  'haha',
  'wow',
  'sad',
  'angry',
  'support',
  'touched',
])
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function fail(status, message) {
  const error = new Error(message)
  error.statusCode = status
  throw error
}

function optionalReaderId(req) {
  try {
    const authorization = String(req.headers.authorization || '')
    if (!authorization.startsWith('Bearer ')) return null
    const decoded = jwt.verify(authorization.slice(7), process.env.JWT_SECRET)
    return decoded.type === 'reader' ? decoded.user_id || null : null
  } catch {
    return null
  }
}

function sendError(res, error, action) {
  const status = Number(error.statusCode || 500)
  if (status >= 500) console.error('AUTHOR PHOTO INTERACTION ERROR:', action, error)
  return res.status(status >= 400 && status < 600 ? status : 500).json({
    ok: false,
    message: status >= 500 ? `Failed to ${action}` : error.message,
  })
}

async function getPhoto(req) {
  const username = String(req.params.pageUsername || '').trim().replace(/^@+/, '').toLowerCase()
  const kind = String(req.params.photoKind || '').trim().toLowerCase()
  if (!/^[a-z0-9_]+$/.test(username)) fail(400, 'Invalid author page username')
  if (kind !== 'cover' && kind !== 'profile') fail(400, 'Invalid photo kind')

  const { data: page, error } = await supabase
    .from('author_pages')
    .select('id,user_id,page_username,avatar_url,cover_url')
    .eq('page_username', username)
    .eq('status', 'active')
    .maybeSingle()

  if (error) throw error
  if (!page) fail(404, 'Author page not found')

  const url = String(kind === 'cover' ? page.cover_url : page.avatar_url || '').trim()
  if (!url) fail(404, 'Photo not found')

  return {
    page,
    kind,
    key: createHash('sha256').update(url, 'utf8').digest('hex'),
  }
}

function requireCurrentPhoto(req, photo) {
  const received = String(req.body?.photo_key || '').trim().toLowerCase()
  if (!/^[a-f0-9]{64}$/.test(received)) fail(400, 'Valid photo_key is required')
  if (received !== photo.key) fail(409, 'Photo has changed. Please reopen the photo.')
}

function photoQuery(table, photo) {
  return supabase
    .from(table)
    .select('id', { head: true, count: 'exact' })
    .eq('author_page_id', photo.page.id)
    .eq('photo_kind', photo.kind)
    .eq('photo_key', photo.key)
}

async function reactionCount(photo) {
  const { count, error } = await photoQuery('author_page_photo_reactions', photo)
  if (error) throw error
  return Number(count || 0)
}

async function commentCount(photo) {
  const { count, error } = await photoQuery('author_page_photo_comments', photo)
    .eq('is_hidden', false)
    .is('deleted_at', null)
  if (error) throw error
  return Number(count || 0)
}

async function checkCommentBlock(req, photo) {
  const block = await getActiveAuthorReaderBlock({
    authorPageId: photo.page.id,
    authorUserId: photo.page.user_id,
    storyId: null,
    readerUserId: req.user.user_id,
  })
  if (block) {
    return authorReaderBlockedPayload(block)
  }
  return null
}

export async function getAuthorPagePhotoSummary(req, res) {
  try {
    res.setHeader('Cache-Control', 'private, no-store')
    const photo = await getPhoto(req)
    const userId = optionalReaderId(req)
    const reactionQuery = userId
      ? supabase
          .from('author_page_photo_reactions')
          .select('reaction_type')
          .eq('author_page_id', photo.page.id)
          .eq('photo_kind', photo.kind)
          .eq('photo_key', photo.key)
          .eq('user_id', userId)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null })
    const [totalReactions, totalComments, myReactionResult] = await Promise.all([
      reactionCount(photo),
      commentCount(photo),
      reactionQuery,
    ])
    if (myReactionResult.error) throw myReactionResult.error
    return res.json({
      ok: true,
      photo_kind: photo.kind,
      photo_key: photo.key,
      reaction_count: totalReactions,
      comment_count: totalComments,
      my_reaction: myReactionResult.data?.reaction_type || null,
    })
  } catch (error) {
    return sendError(res, error, 'load photo interactions')
  }
}

export async function setAuthorPagePhotoReaction(req, res) {
  try {
    const photo = await getPhoto(req)
    requireCurrentPhoto(req, photo)
    const userId = req.user?.user_id
    if (!userId) fail(401, 'Unauthorized')

    const hasDesired = Object.prototype.hasOwnProperty.call(req.body || {}, 'desired_reaction_type')
    const desired = hasDesired ? req.body.desired_reaction_type : req.body?.reaction_type
    if (desired === undefined) fail(400, 'Reaction type is required')
    const reactionType = desired === null || desired === '' ? null : String(desired).trim().toLowerCase()
    if (reactionType && !REACTION_TYPES.has(reactionType)) fail(400, 'Invalid reaction type')

    const scope = supabase.from('author_page_photo_reactions')
    if (reactionType) {
      const { error } = await scope.upsert({
        author_page_id: photo.page.id,
        user_id: userId,
        photo_kind: photo.kind,
        photo_key: photo.key,
        reaction_type: reactionType,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'author_page_id,photo_kind,photo_key,user_id' })
      if (error) throw error
    } else {
      const { error } = await scope.delete()
        .eq('author_page_id', photo.page.id)
        .eq('photo_kind', photo.kind)
        .eq('photo_key', photo.key)
        .eq('user_id', userId)
      if (error) throw error
    }

    return res.json({
      ok: true,
      photo_key: photo.key,
      my_reaction: reactionType,
      reaction_count: await reactionCount(photo),
    })
  } catch (error) {
    return sendError(res, error, 'update photo reaction')
  }
}

export async function getAuthorPagePhotoComments(req, res) {
  try {
    res.setHeader('Cache-Control', 'private, no-store')
    const photo = await getPhoto(req)
    const rawLimit = Number(req.query.limit || 20)
    const rawOffset = Number(req.query.offset || 0)
    const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(50, Math.floor(rawLimit))) : 20
    const offset = Number.isFinite(rawOffset) ? Math.max(0, Math.min(10000, Math.floor(rawOffset))) : 0
    const parentId = String(req.query.parent_id || '').trim()
    if (parentId && !UUID_PATTERN.test(parentId)) fail(400, 'Invalid parent_id')

    let query = supabase
      .from('author_page_photo_comments')
      .select('id,user_id,parent_id,text,created_at,updated_at,user:users(id,name,username,avatar_url)', { count: 'exact' })
      .eq('author_page_id', photo.page.id)
      .eq('photo_kind', photo.kind)
      .eq('photo_key', photo.key)
      .eq('is_hidden', false)
      .is('deleted_at', null)

    query = parentId ? query.eq('parent_id', parentId) : query.is('parent_id', null)
    const { data, count, error } = await query
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range(offset, offset + limit - 1)

    if (error) throw error
    return res.json({
      ok: true,
      photo_key: photo.key,
      comments: data || [],
      total: Number(count || 0),
      limit,
      offset,
      has_more: offset + (data?.length || 0) < Number(count || 0),
    })
  } catch (error) {
    return sendError(res, error, 'load photo comments')
  }
}

export async function createAuthorPagePhotoComment(req, res) {
  try {
    const photo = await getPhoto(req)
    requireCurrentPhoto(req, photo)
    const userId = req.user?.user_id
    if (!userId) fail(401, 'Unauthorized')
    const text = String(req.body?.text || '').normalize('NFC').trim()
    const parentId = String(req.body?.parent_id || '').trim() || null
    if (!text || text.length > 1000) fail(400, 'Comment must contain 1 to 1000 characters')
    if (parentId && !UUID_PATTERN.test(parentId)) fail(400, 'Invalid parent_id')

    const block = await checkCommentBlock(req, photo)
    if (block) return res.status(403).json(block)

    const minuteAgo = new Date(Date.now() - 60000).toISOString()
    const { count: recentCount, error: recentError } = await supabase
      .from('author_page_photo_comments')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .gte('created_at', minuteAgo)
    if (recentError) throw recentError
    if (Number(recentCount || 0) >= 8) fail(429, 'Too many comments. Try again later.')

    if (parentId) {
      const { data: parent, error } = await supabase
        .from('author_page_photo_comments')
        .select('id,parent_id')
        .eq('id', parentId)
        .eq('author_page_id', photo.page.id)
        .eq('photo_kind', photo.kind)
        .eq('photo_key', photo.key)
        .eq('is_hidden', false)
        .is('deleted_at', null)
        .maybeSingle()
      if (error) throw error
      if (!parent || parent.parent_id) fail(400, 'Invalid reply target')
    }

    const { data, error } = await supabase
      .from('author_page_photo_comments')
      .insert({
        author_page_id: photo.page.id,
        photo_kind: photo.kind,
        photo_key: photo.key,
        user_id: userId,
        parent_id: parentId,
        text,
      })
      .select('id,user_id,parent_id,text,created_at,updated_at,user:users(id,name,username,avatar_url)')
      .single()
    if (error) throw error

    return res.status(201).json({
      ok: true,
      comment: data,
      comment_count: await commentCount(photo),
    })
  } catch (error) {
    return sendError(res, error, 'create photo comment')
  }
}

export async function updateAuthorPagePhotoComment(req, res) {
  try {
    const photo = await getPhoto(req)
    requireCurrentPhoto(req, photo)
    const userId = req.user?.user_id
    if (!userId) fail(401, 'Unauthorized')
    const commentId = String(req.params.commentId || '')
    const text = String(req.body?.text || '').normalize('NFC').trim()
    if (!UUID_PATTERN.test(commentId)) fail(400, 'Invalid comment ID')
    if (!text || text.length > 1000) fail(400, 'Comment must contain 1 to 1000 characters')

    const { data, error } = await supabase
      .from('author_page_photo_comments')
      .update({ text, updated_at: new Date().toISOString() })
      .eq('id', commentId)
      .eq('user_id', userId)
      .eq('author_page_id', photo.page.id)
      .eq('photo_kind', photo.kind)
      .eq('photo_key', photo.key)
      .eq('is_hidden', false)
      .is('deleted_at', null)
      .select('id,user_id,parent_id,text,created_at,updated_at,user:users(id,name,username,avatar_url)')
      .maybeSingle()
    if (error) throw error
    if (!data) fail(404, 'Comment not found')
    return res.json({ ok: true, comment: data })
  } catch (error) {
    return sendError(res, error, 'update photo comment')
  }
}

export async function deleteAuthorPagePhotoComment(req, res) {
  try {
    const photo = await getPhoto(req)
    requireCurrentPhoto(req, photo)
    const userId = req.user?.user_id
    if (!userId) fail(401, 'Unauthorized')
    const commentId = String(req.params.commentId || '')
    if (!UUID_PATTERN.test(commentId)) fail(400, 'Invalid comment ID')

    const { data, error } = await supabase
      .from('author_page_photo_comments')
      .update({ deleted_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', commentId)
      .eq('user_id', userId)
      .eq('author_page_id', photo.page.id)
      .eq('photo_kind', photo.kind)
      .eq('photo_key', photo.key)
      .is('deleted_at', null)
      .select('id')
      .maybeSingle()
    if (error) throw error
    if (!data) fail(404, 'Comment not found')

    const { error: repliesError } = await supabase
      .from('author_page_photo_comments')
      .update({ deleted_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('parent_id', commentId)
      .eq('author_page_id', photo.page.id)
      .eq('photo_kind', photo.kind)
      .eq('photo_key', photo.key)
      .is('deleted_at', null)
    if (repliesError) throw repliesError

    return res.json({ ok: true, comment_id: data.id, comment_count: await commentCount(photo) })
  } catch (error) {
    return sendError(res, error, 'delete photo comment')
  }
}
