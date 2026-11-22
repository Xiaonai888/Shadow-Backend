import { supabase } from '../config/supabase.js'
import { checkOneShadowYoutubeVideo, checkShadowYoutubeVideos, parseShadowYoutubeId } from '../services/youtubeReelAvailabilityMonitor.service.js'
import { invalidateStudioChannelCache } from '../services/shadowStudioChannelCache.service.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const FIELDS = 'id,user_id,title,description,video_url,thumbnail_url,video_type,duration_seconds,view_count,youtube_visibility,youtube_checked_at,youtube_unavailable_since,youtube_unavailable_reason'

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
    .eq('studio_state', 'active').eq('youtube_visibility', 'unavailable')
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
      .eq('youtube_visibility', 'unavailable')
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
    const result = await checkOneShadowYoutubeVideo(row)
    if (!result || result.state === 'unknown') {
      return res.status(503).json({ ok: false, message: 'YouTube verification is temporarily unavailable.' })
    }
    res.set('Cache-Control', 'private, no-store')
    return res.json({ ok: true, available: result.state === 'available', reason: result.reason || '' })
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
    const youtubeId = parseShadowYoutubeId(candidate)
    const result = (await checkShadowYoutubeVideos([youtubeId])).get(youtubeId)
    if (result?.state !== 'available') {
      return res.status(409).json({ ok: false, message: result?.state === 'unknown'
        ? 'YouTube could not be verified. Please try again.'
        : 'This YouTube link cannot be played in Shadow.' })
    }
    const { data, error } = await supabase.rpc('shadow_reel_repair_unavailable_link', {
      p_owner: owner,
      p_id: id,
      p_new_url: candidate,
      p_new_thumbnail: `https://img.youtube.com/vi/${youtubeId}/hqdefault.jpg`,
    })
    if (error) throw error
    if (data?.ok !== true) return res.status(409).json({ ok: false, message: 'Video changed. Refresh and try again.' })
    invalidateStudioChannelCache(owner)
    res.set('Cache-Control', 'private, no-store')
    return res.json({ ok: true, id, restored: true })
  } catch (error) { return fail(res, error, 'REPAIR') }
}
