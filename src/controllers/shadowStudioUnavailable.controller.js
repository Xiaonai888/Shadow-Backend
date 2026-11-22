import { supabase } from '../config/supabase.js'
import { studioYoutubeId, probeStudioYoutubeIds } from '../services/shadowStudioYoutubeProbe.service.js'
import { invalidateStudioChannelCache } from '../services/shadowStudioChannelCache.service.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const FIELDS = 'id,user_id,title,description,video_url,thumbnail_url,video_type,duration_seconds,view_count,status,youtube_health_state,youtube_health_checked_at,youtube_health_due_at,youtube_unavailable_since,youtube_restore_status'

function params(req, res) {
  const owner = String(req.user?.user_id || '')
  if (!UUID.test(owner)) {
    res.status(401).json({ ok: false, message: 'Sign in to use Shadow Studio.' })
    return null
  }
  return owner
}

function fail(res, error, tag) {
  console.error(`[SHADOW_STUDIO_UNAVAILABLE_${tag}]`, error?.message || error)
  return res.status(500).json({ ok: false, message: 'Could not complete this video request.' })
}

async function findOwnerVideo(owner, id) {
  const result = await supabase.from('fast_videos').select(FIELDS)
    .eq('id', id).eq('user_id', owner)
    .eq('studio_state', 'active').eq('youtube_health_state', 'unavailable')
    .maybeSingle()
  if (result.error) throw result.error
  return result.data
}

export async function listStudioUnavailableVideos(req, res) {
  const owner = params(req, res)
  if (!owner) return
  const limit = Number(req.query.limit ?? 12)
  const offset = Number(req.query.offset ?? 0)
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 24 ||
    !Number.isSafeInteger(offset) || offset < 0 || offset > 5000) {
    return res.status(400).json({ ok: false, message: 'Invalid pagination.' })
  }
  try {
    const { data, error } = await supabase.from('fast_videos')
      .select(FIELDS)
      .eq('user_id', owner).eq('studio_state', 'active')
      .eq('youtube_health_state', 'unavailable')
      .order('youtube_unavailable_since', { ascending: false })
      .order('id', { ascending: false })
      .range(offset, offset + limit)
    if (error) throw error
    const rows = Array.isArray(data) ? data : []
    res.set('Cache-Control', 'private, no-store')
    return res.json({
      ok: true,
      videos: rows.slice(0, limit),
      pagination: {
        limit, offset,
        next_offset: offset + Math.min(rows.length, limit),
        has_more: rows.length > limit,
      },
    })
  } catch (error) { return fail(res, error, 'LIST') }
}

export async function recheckStudioUnavailableVideo(req, res) {
  const owner = params(req, res)
  if (!owner) return
  const id = String(req.params.id || '')
  if (!UUID.test(id)) return res.status(400).json({ ok: false, message: 'Invalid video ID.' })
  try {
    const row = await findOwnerVideo(owner, id)
    if (!row) return res.status(404).json({ ok: false, message: 'Video no longer unavailable.' })
    const youtubeId = studioYoutubeId(row.video_url)
    const state = youtubeId ? (await probeStudioYoutubeIds([youtubeId])).get(youtubeId) : 'missing'
    if (!state || state === 'unknown') {
      return res.status(503).json({ ok: false, message: 'YouTube verification is temporarily unavailable.' })
    }
    if (state === 'live') {
      const now = Date.now()
      const { data: saved, error } = await supabase.from('fast_videos')
        .update({
          youtube_health_state: 'live',
          youtube_health_checked_at: new Date(now).toISOString(),
          youtube_health_due_at: new Date(now + 24 * 60 * 60 * 1000).toISOString(),
          youtube_health_missing_count: 0,
          youtube_unavailable_since: null,
          youtube_restore_status: null,
          status: row.youtube_restore_status === 'published' ? 'published' : row.status,
        })
        .eq('id', id)
        .eq('user_id', owner)
        .eq('studio_state', 'active')
        .eq('youtube_health_state', 'unavailable')
        .eq('video_url', row.video_url)
        .select('id')
        .maybeSingle()
      if (error) throw error
      if (!saved) return res.status(409).json({ ok: false, message: 'Video changed. Refresh and try again.' })
      invalidateStudioChannelCache(owner)
    }
    res.set('Cache-Control', 'private, no-store')
    return res.json({ ok: true, available: state === 'live', reason: state === 'missing' ? 'youtube_unavailable' : '' })
  } catch (error) { return fail(res, error, 'RECHECK') }
}

export async function replaceStudioUnavailableLink(req, res) {
  const owner = params(req, res)
  if (!owner) return
  const id = String(req.params.id || '')
  const candidate = String(req.body?.video_url || '').trim()
  if (!UUID.test(id) || candidate.length > 500 || !parseShadowYoutubeId(candidate) ||
    Object.keys(req.body || {}).some(key => key !== 'video_url')) {
    return res.status(400).json({ ok: false, message: 'Enter a valid YouTube link.' })
  }
  try {
    const row = await findOwnerVideo(owner, id)
    if (!row) return res.status(404).json({ ok: false, message: 'Video no longer unavailable.' })
export async function replaceStudioUnavailableLink(req, res) {
  const owner = params(req, res)
  if (!owner) return
  const id = String(req.params.id || '')
  const candidate = String(req.body?.video_url || '').trim()
  if (!UUID.test(id) || candidate.length > 500 || !studioYoutubeId(candidate) ||
      Object.keys(req.body || {}).some(key => key !== 'video_url')) {
    return res.status(400).json({ ok: false, message: 'Enter a valid YouTube link.' })
  }
  try {
    const row = await findOwnerVideo(owner, id)
    if (!row) return res.status(404).json({ ok: false, message: 'Video no longer unavailable.' })
    const youtubeId = studioYoutubeId(candidate)
    const state = (await probeStudioYoutubeIds([youtubeId])).get(youtubeId)
    if (state !== 'live') {
      return res.status(409).json({ ok: false, message: state === 'unknown'
        ? 'YouTube could not be verified. Please try again.'
        : 'This YouTube link cannot be played in Shadow.' })
    }
    const { data: saved, error } = await supabase.from('fast_videos')
      .update({
        video_url: candidate,
        thumbnail_url: `https://img.youtube.com/vi/${youtubeId}/hqdefault.jpg`,
        status: row.youtube_restore_status === 'published' ? 'published' : row.status,
        youtube_health_state: 'unchecked',
        youtube_health_checked_at: null,
        youtube_health_due_at: new Date().toISOString(),
        youtube_health_missing_count: 0,
        youtube_unavailable_since: null,
        youtube_restore_status: null,
      })
      .eq('id', id)
      .eq('user_id', owner)
      .eq('studio_state', 'active')
      .eq('youtube_health_state', 'unavailable')
      .eq('video_url', row.video_url)
      .select('id')
      .maybeSingle()
    if (error) throw error
    if (!saved) return res.status(409).json({ ok: false, message: 'Video changed. Refresh and try again.' })
    invalidateStudioChannelCache(owner)
    res.set('Cache-Control', 'private, no-store')
    return res.json({ ok: true, id, restored: true })
  } catch (error) { return fail(res, error, 'REPAIR') }
}
