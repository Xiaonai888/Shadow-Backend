import { supabase } from '../config/supabase.js'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const PAGE_SIZE = 20
const MAX_PAGE_SIZE = 30
const MAX_REVIEW_SIZE = 30

function readerId(req) {
  return String(req.user?.user_id || req.user?.id || '').trim()
}

function respond(res, status, payload) {
  res.set('Cache-Control', 'private, no-store')
  return res.status(status).json(payload)
}

function positiveInteger(value, fallback, maximum) {
  const n = Number(value)
  return Number.isSafeInteger(n) && n >= 1 && n <= maximum ? n : fallback
}

export async function getPendingReaderTags(req, res) {
  const userId = readerId(req)
  if (!UUID_PATTERN.test(userId)) {
    return respond(res, 401, { ok: false, message: 'Please sign in again.' })
  }

  const page = positiveInteger(req.query?.page, 1, 10000)
  const limit = positiveInteger(req.query?.limit, PAGE_SIZE, MAX_PAGE_SIZE)
  const offset = (page - 1) * limit

  try {
    const { data, error, count } = await supabase
      .from('reader_tag_mention_links')
      .select('id,post_id,actor_user_id,created_at', { count: 'exact' })
      .eq('target_user_id', userId)
      .eq('kind', 'tag')
      .eq('status', 'pending')
      .not('post_id', 'is', null)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range(offset, offset + limit - 1)
    if (error) throw error

    const rows = data || []
    const actorIds = [...new Set(rows.map((row) => row.actor_user_id).filter(Boolean))]
    let userMap = new Map()

    if (actorIds.length) {
      const { data: users, error: usersError } = await supabase
        .from('users')
        .select('id,name,username,avatar_url')
        .in('id', actorIds)
        .eq('is_active', true)
      if (usersError) throw usersError
      userMap = new Map((users || []).map((user) => [String(user.id), user]))
    }

    const total = Number(count || 0)
    return respond(res, 200, {
      ok: true,
      tags: rows.map((row) => ({
        id: row.id,
        post_id: row.post_id,
        created_at: row.created_at,
        tagged_by: userMap.get(String(row.actor_user_id)) || null,
      })),
      page,
      limit,
      total,
      has_more: offset + limit < total,
    })
  } catch (error) {
    console.error('READER_PENDING_TAGS_ERROR:', error)
    return respond(res, 500, { ok: false, message: 'Unable to load pending tags.' })
  }
}

export async function reviewPendingReaderTags(req, res) {
  const userId = readerId(req)
  if (!UUID_PATTERN.test(userId)) {
    return respond(res, 401, { ok: false, message: 'Please sign in again.' })
  }

  const { action, ids } = req.body || {}
  if (
    !['approve', 'reject'].includes(action) ||
    !Array.isArray(ids) ||
    ids.length < 1 ||
    ids.length > MAX_REVIEW_SIZE ||
    !ids.every((id) => typeof id === 'string' && UUID_PATTERN.test(id))
  ) {
    return respond(res, 400, { ok: false, message: 'Provide approve or reject and 1–30 valid tag IDs.' })
  }

  const uniqueIds = [...new Set(ids)]
  try {
    const { data, error } = await supabase
      .from('reader_tag_mention_links')
      .update({
        status: action === 'approve' ? 'approved' : 'rejected',
        reviewed_at: new Date().toISOString(),
      })
      .eq('target_user_id', userId)
      .eq('kind', 'tag')
      .eq('status', 'pending')
      .not('post_id', 'is', null)
      .in('id', uniqueIds)
      .select('id')
    if (error) throw error

    const reviewedIds = (data || []).map((row) => row.id)
    return respond(res, 200, {
      ok: true,
      action,
      reviewed_ids: reviewedIds,
      reviewed_count: reviewedIds.length,
      skipped_count: uniqueIds.length - reviewedIds.length,
    })
  } catch (error) {
    console.error('READER_TAG_REVIEW_ERROR:', error)
    return respond(res, 500, { ok: false, message: 'Unable to review tags.' })
  }
}
