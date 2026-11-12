import { supabase } from '../config/supabase.js'
import { executeStudioRecycleAction } from '../services/shadowStudioRecycleBridge.service.js'
import { invalidateStudioChannelCache } from '../services/shadowStudioChannelCache.service.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const VIDEO_FIELDS = 'id,user_id,video_url,thumbnail_url,title,description,tags,status,access_type,unlock_price_diamonds,published_at,view_count,video_type,duration_seconds,archived_at,deleted_at,purge_at'

function userId(req, res) {
  const value = req.user?.user_id
  if (!value || !UUID.test(String(value))) {
    res.status(401).json({ ok: false, message: 'Unauthorized' })
    return null
  }
  return value
}

function pagination(req, res) {
  const limit = Number(req.query.limit ?? 12)
  const offset = Number(req.query.offset ?? 0)
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 24 ||
      !Number.isSafeInteger(offset) || offset < 0 || offset > 5000) {
    res.status(400).json({ ok: false, message: 'Invalid pagination' })
    return null
  }
  return { limit, offset }
}

function failure(res, error, context) {
  console.error(`SHADOW STUDIO ME ${context} ERROR:`, error)
  return res.status(500).json({ ok: false, message: 'Unable to complete Studio request' })
}

function paged(res, rows, limit, offset) {
  const videos = (rows || []).slice(0, limit)
  res.set('Cache-Control', 'private, no-store')
  return res.json({
    ok: true,
    videos,
    pagination: {
      limit,
      offset,
      next_offset: offset + videos.length,
      has_more: (rows || []).length > limit,
    },
  })
}

export async function getStudioMeSummary(req, res) {
  const owner = userId(req, res)
  if (!owner) return
  try {
    const { data, error } = await supabase.rpc('shadow_studio_me_summary', { p_owner: owner })
    if (error) throw error
    res.set('Cache-Control', 'private, no-store')
    return res.json({ ok: true, totals: data || { total: 0, long: 0, short: 0 } })
  } catch (error) {
    return failure(res, error, 'SUMMARY')
  }
}

export async function listStudioMeVideos(req, res) {
  const owner = userId(req, res)
  if (!owner) return
  const page = pagination(req, res)
  if (!page) return
  const kind = String(req.query.kind ?? 'all').toLowerCase()
  const search = String(req.query.search ?? '').trim()
  if (!['all', 'long', 'short'].includes(kind) || search.length > 100) {
    return res.status(400).json({ ok: false, message: 'Invalid video filter' })
  }
  try {
    let query = supabase.from('fast_videos')
      .select(VIDEO_FIELDS)
      .eq('user_id', owner)
      .eq('studio_state', 'active')
    if (kind === 'short') query = query.eq('video_type', 'short')
    if (kind === 'long') query = query.or('video_type.eq.long,video_type.is.null')
    if (search) query = query.ilike('title', `%${search.replace(/[\\%_]/g, '\\$&')}%`)
    const { data, error } = await query
      .order('published_at', { ascending: false, nullsFirst: false })
      .order('id', { ascending: false })
      .range(page.offset, page.offset + page.limit)
    if (error) throw error
    return paged(res, data, page.limit, page.offset)
  } catch (error) {
    return failure(res, error, 'VIDEOS')
  }
}

export async function listStudioMeArchive(req, res) {
  const owner = userId(req, res)
  if (!owner) return
  const page = pagination(req, res)
  if (!page) return
  try {
    const { data, error } = await supabase.from('fast_videos')
      .select(VIDEO_FIELDS)
      .eq('user_id', owner)
      .eq('studio_state', 'archived')
      .order('archived_at', { ascending: false })
      .order('id', { ascending: false })
      .range(page.offset, page.offset + page.limit)
    if (error) throw error
    return paged(res, data, page.limit, page.offset)
  } catch (error) {
    return failure(res, error, 'ARCHIVE')
  }
}

export async function listStudioMeTrash(req, res) {
  const owner = userId(req, res)
  if (!owner) return
  const page = pagination(req, res)
  if (!page) return
  try {
    const { data, error } = await supabase.from('fast_videos')
      .select(VIDEO_FIELDS)
      .eq('user_id', owner)
      .eq('studio_state', 'trashed')
      .gt('purge_at', new Date().toISOString())
      .order('deleted_at', { ascending: false })
      .order('id', { ascending: false })
      .range(page.offset, page.offset + page.limit)
    if (error) throw error
    return paged(res, data, page.limit, page.offset)
  } catch (error) {
    return failure(res, error, 'TRASH')
  }
}

async function changeVideo(req, res, action) {
  const owner = userId(req, res)
  if (!owner) return
  const videoId = String(req.params.id || '')
  if (!UUID.test(videoId)) {
    return res.status(400).json({ ok: false, message: 'Invalid video ID' })
  }
  try {
    const data = await executeStudioRecycleAction({
  ownerId: owner,
  videoId,
  action,
  client: supabase,
  invalidate: invalidateStudioChannelCache,
})
    if (data?.ok !== true) {
      const status = data?.code === 'NOT_FOUND' ? 404 : data?.code === 'EXPIRED' ? 410 : 409
      return res.status(status).json({ ok: false, message: data?.code || 'Video state conflict' })
    }
    res.set('Cache-Control', 'private, no-store')
    return res.json(data)
  } catch (error) {
    return failure(res, error, action.toUpperCase())
  }
}

export function setStudioMeArchived(req, res) {
  if (typeof req.body?.archived !== 'boolean' ||
      Object.keys(req.body || {}).some(key => key !== 'archived')) {
    return res.status(400).json({ ok: false, message: 'Invalid archive action' })
  }
  return changeVideo(req, res, req.body.archived ? 'archive' : 'unarchive')
}

export function moveStudioMeToTrash(req, res) {
  return changeVideo(req, res, 'trash')
}

export function restoreStudioMeFromTrash(req, res) {
  return changeVideo(req, res, 'restore')
}

export function deleteStudioMeForever(req, res) {
  return changeVideo(req, res, 'purge')
}
