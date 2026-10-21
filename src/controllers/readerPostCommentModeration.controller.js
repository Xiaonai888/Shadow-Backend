import { supabase } from '../config/supabase.js'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const PAGE_SIZE = 20
const MAX_PAGE_SIZE = 30
const MAX_BATCH_SIZE = 30

function actorId(req) {
  return String(req.user?.user_id || req.user?.id || '').trim()
}

function respond(res, status, payload) {
  res.set('Cache-Control', 'private, no-store')
  return res.status(status).json(payload)
}

function pageNumber(value) {
  const n = Number(value)
  return Number.isSafeInteger(n) && n >= 1 && n <= 10000 ? n : 1
}

function pageSize(value) {
  const n = Number(value)
  return Number.isSafeInteger(n) && n >= 1 ? Math.min(n, MAX_PAGE_SIZE) : PAGE_SIZE
}

async function readOwnedPost(postId, ownerId) {
  const { data, error } = await supabase
    .from('reader_posts')
    .select('id')
    .eq('id', postId)
    .eq('user_id', ownerId)
    .is('deleted_at', null)
    .maybeSingle()
  if (error) throw error
  return data
}

export async function getPendingReaderPostComments(req, res) {
  const ownerId = actorId(req)
  const postId = String(req.params.postId || '').trim()
  if (!ownerId) return respond(res, 401, { ok: false, message: 'Please sign in again.' })
  if (!UUID_PATTERN.test(postId)) return respond(res, 400, { ok: false, message: 'Invalid post ID.' })

  try {
    if (!await readOwnedPost(postId, ownerId)) {
      return respond(res, 404, { ok: false, message: 'Post not found.' })
    }

    const page = pageNumber(req.query.page)
    const limit = pageSize(req.query.limit)
    const from = (page - 1) * limit
    const { data, error, count } = await supabase
      .from('reader_post_comments')
      .select('id,post_id,user_id,parent_id,text,created_at,user:users(id,name,username,avatar_url)', { count: 'exact' })
      .eq('post_id', postId)
      .eq('moderation_status', 'pending')
      .eq('is_hidden', true)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range(from, from + limit - 1)
    if (error) throw error

    const total = Number(count || 0)
    return respond(res, 200, {
      ok: true,
      comments: data || [],
      page,
      limit,
      total,
      has_more: from + limit < total,
    })
  } catch (error) {
    console.error('READER_PENDING_COMMENTS_ERROR:', error)
    return respond(res, 500, { ok: false, message: 'Could not load pending comments.' })
  }
}

export async function reviewPendingReaderPostComments(req, res) {
  const ownerId = actorId(req)
  const postId = String(req.params.postId || '').trim()
  if (!ownerId) return respond(res, 401, { ok: false, message: 'Please sign in again.' })
  if (!UUID_PATTERN.test(postId)) return respond(res, 400, { ok: false, message: 'Invalid post ID.' })

  const { action, ids } = req.body || {}
  if (!['approve', 'reject'].includes(action) || !Array.isArray(ids) || !ids.length || ids.length > MAX_BATCH_SIZE || !ids.every((id) => typeof id === 'string' && UUID_PATTERN.test(id))) {
    return respond(res, 400, { ok: false, message: 'Provide approve or reject and 1–30 valid comment IDs.' })
  }

  try {
    if (!await readOwnedPost(postId, ownerId)) {
      return respond(res, 404, { ok: false, message: 'Post not found.' })
    }

    const commentIds = [...new Set(ids)]
    const approving = action === 'approve'
    const { data, error } = await supabase
      .from('reader_post_comments')
      .update({
        moderation_status: approving ? 'approved' : 'rejected',
        is_hidden: !approving,
        moderated_by: ownerId,
        moderated_at: new Date().toISOString(),
      })
      .eq('post_id', postId)
      .eq('moderation_status', 'pending')
      .eq('is_hidden', true)
      .in('id', commentIds)
      .select('id')
    if (error) throw error

    const reviewedIds = (data || []).map((item) => item.id)
    if (reviewedIds.length) {
      const { error: mentionError } = await supabase
        .from('reader_tag_mention_links')
        .update({
          status: approving ? 'approved' : 'rejected',
          reviewed_at: new Date().toISOString(),
        })
        .in('comment_id', reviewedIds)
        .eq('kind', 'mention')
        .eq('status', 'pending')
      if (mentionError) {
        console.error('READER_COMMENT_MENTION_REVIEW_ERROR:', mentionError)
      }
    }
    let commentCount = null
    if (approving && reviewedIds.length) {
      const { count, error: countError } = await supabase
        .from('reader_post_comments')
        .select('id', { count: 'exact', head: true })
        .eq('post_id', postId)
        .eq('is_hidden', false)
      if (countError) throw countError
      commentCount = Number(count || 0)
      const { error: updateError } = await supabase
        .from('reader_posts')
        .update({ comment_count: commentCount })
        .eq('id', postId)
        .eq('user_id', ownerId)
        .is('deleted_at', null)
      if (updateError) throw updateError
    }

    return respond(res, 200, {
      ok: true,
      action,
      reviewed_ids: reviewedIds,
      reviewed_count: reviewedIds.length,
      skipped_count: commentIds.length - reviewedIds.length,
      ...(commentCount === null ? {} : { comment_count: commentCount }),
    })
  } catch (error) {
    console.error('REVIEW_READER_COMMENTS_ERROR:', error)
    return respond(res, 500, { ok: false, message: 'Could not review comments.' })
  }
}
