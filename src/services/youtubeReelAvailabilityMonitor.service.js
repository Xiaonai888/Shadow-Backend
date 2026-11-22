import { supabase } from '../config/supabase.js'
import { invalidateStudioChannelCache } from './shadowStudioChannelCache.service.js'

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/
const CHECK_INTERVAL = 24 * 60 * 60 * 1000
const PULSE_INTERVAL = 15 * 60 * 1000
const BATCH_LIMIT = 50
const MAX_PER_PULSE = 200
let working = false
let monitor = null

export function parseShadowYoutubeId(raw) {
  try {
    const url = new URL(String(raw || ''))
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return ''
    const host = url.hostname.toLowerCase()
    const path = url.pathname.split('/').filter(Boolean)
    let id = ''
    if (['youtu.be', 'www.youtu.be'].includes(host)) id = path[0] || ''
    if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtube-nocookie.com', 'www.youtube-nocookie.com'].includes(host)) {
      if (path[0] === 'watch') id = url.searchParams.get('v') || ''
      if (['shorts', 'embed', 'live'].includes(path[0])) id = path[1] || ''
    }
    return YOUTUBE_ID.test(id) ? id : ''
  } catch { return '' }
}

async function youtubeDataApiCheck(ids, key) {
  const url = new URL('https://www.googleapis.com/youtube/v3/videos')
  url.searchParams.set('part', 'status')
  url.searchParams.set('id', ids.join(','))
  url.searchParams.set('key', key)
  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(8000),
  })
  if (!response.ok) throw new Error(`YouTube Data API HTTP ${response.status}`)
  const payload = await response.json()
  if (!Array.isArray(payload.items)) throw new Error('Invalid YouTube Data API response')
  const map = new Map(ids.map(id => [id, { state: 'unavailable', source: 'google', reason: 'missing_or_private' }]))
  for (const video of payload.items) {
    const status = video.status || {}
    if (!YOUTUBE_ID.test(String(video.id))) continue
    const available = ['public', 'unlisted'].includes(status.privacyStatus) &&
      status.uploadStatus !== 'deleted' && status.embeddable !== false
    const confirmedUnavailable = status.privacyStatus === 'private' ||
      status.uploadStatus === 'deleted' || status.embeddable === false
    map.set(video.id, available
      ? { state: 'available', source: 'google', reason: '' }
      : confirmedUnavailable
        ? { state: 'unavailable', source: 'google', reason: 'private_or_embedding_disabled' }
        : { state: 'unknown', source: 'none', reason: 'youtube_status_inconclusive' })
  }
  return map
}

async function youtubeOembedCheck(id) {
  const source = `https://www.youtube.com/watch?v=${id}`
  const url = `https://www.youtube.com/oembed?url=${encodeURIComponent(source)}&format=json`
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) })
    if (response.ok) return { state: 'available', source: 'oembed', reason: '' }
    if (response.status === 404 || response.status === 410) {
      return { state: 'unavailable', source: 'oembed', reason: 'oembed_unavailable' }
    }
  } catch {}
  return { state: 'unknown', source: 'none', reason: 'oembed_inconclusive' }
}

export async function checkShadowYoutubeVideos(ids) {
  const unique = [...new Set(ids.filter(id => YOUTUBE_ID.test(String(id))))].slice(0, 50)
  if (!unique.length) return new Map()
  const key = String(process.env.YOUTUBE_DATA_API_KEY || process.env.YOUTUBE_API_KEY || '').trim()
  if (key) {
    try { return await youtubeDataApiCheck(unique, key) }
    catch (error) { console.warn('[SHADOW_YOUTUBE_CHECK_API_ERROR]', error.message) }
  }
  const results = new Map()
  let cursor = 0
  await Promise.all(Array.from({ length: Math.min(4, unique.length) }, async () => {
    while (cursor < unique.length) {
      const id = unique[cursor++]
      results.set(id, await youtubeOembedCheck(id))
    }
  }))
  return results
}

async function persistAvailability(video, result) {
  const { data, error } = await supabase.rpc('shadow_reel_set_youtube_availability', {
    p_id: video.id,
    p_expected_url: video.video_url,
    p_result: result.state,
    p_source: result.source,
    p_reason: result.reason || null,
  })
  if (error) throw error
  if (data?.ok === true) invalidateStudioChannelCache(video.user_id)
  return data?.ok === true
}

async function autoTrashIfDue(video, result) {
  if (result.state !== 'unavailable') return
  const { data: current, error } = await supabase.from('fast_videos')
    .select('id,youtube_visibility,youtube_unavailable_since')
    .eq('id', video.id).eq('studio_state', 'active').maybeSingle()
  if (error) throw error
  if (current?.youtube_visibility !== 'unavailable') return
  const since = Date.parse(String(current.youtube_unavailable_since || ''))
  if (!Number.isFinite(since) || Date.now() - since < 30 * 86400000) return
  const moved = await supabase.rpc('shadow_reel_auto_trash_unavailable', {
    p_id: video.id, p_expected_url: video.video_url,
  })
  if (moved.error) throw moved.error
  if (moved.data?.ok === true) invalidateStudioChannelCache(video.user_id)
}

export async function checkOneShadowYoutubeVideo(video) {
  if (!video?.id || !video?.video_url) return null
  const id = parseShadowYoutubeId(video.video_url)
  const result = id
    ? (await checkShadowYoutubeVideos([id])).get(id)
    : { state: 'unavailable', source: 'google', reason: 'invalid_youtube_url' }
  if (!result) return null
  const saved = await persistAvailability(video, result)
  if (saved) await autoTrashIfDue(video, result)
  return result
}

export async function sweepShadowYoutubeReels() {
  if (working) return { skipped: true }
  working = true
  let processed = 0
  let errors = 0
  try {
    const cutoff = new Date(Date.now() - CHECK_INTERVAL).toISOString()
    const { data, error } = await supabase.from('fast_videos')
      .select('id,user_id,video_url,youtube_checked_at')
      .eq('platform', 'youtube').eq('studio_state', 'active')
      .or(`youtube_checked_at.is.null,youtube_checked_at.lt.${cutoff}`)
      .order('youtube_checked_at', { ascending: true, nullsFirst: true })
      .order('id', { ascending: true })
      .limit(MAX_PER_PULSE)
    if (error) throw error
    for (let cursor = 0; cursor < (data || []).length; cursor += BATCH_LIMIT) {
      const batch = data.slice(cursor, cursor + BATCH_LIMIT)
      const ids = batch.map(row => parseShadowYoutubeId(row.video_url)).filter(Boolean)
      const checked = await checkShadowYoutubeVideos(ids)
      for (const video of batch) {
        try {
          const id = parseShadowYoutubeId(video.video_url)
          const result = id
            ? (checked.get(id) || { state: 'unknown', source: 'none', reason: 'check_unavailable' })
            : { state: 'unavailable', source: 'google', reason: 'invalid_youtube_url' }
          if (await persistAvailability(video, result)) await autoTrashIfDue(video, result)
          processed += 1
        } catch (cause) {
          errors += 1
          console.warn('[SHADOW_YOUTUBE_VIDEO_CHECK_ERROR]', video.id, cause?.message)
        }
      }
    }
    if (processed || errors) console.info('[SHADOW_YOUTUBE_SWEEP]', { processed, errors })
    return { processed, errors }
  } catch (error) {
    console.error('[SHADOW_YOUTUBE_SWEEP_FAILED]', error?.message)
    return { processed, errors: errors + 1 }
  } finally {
    working = false
  }
}

export function startShadowYoutubeReelMonitor() {
  if (monitor) return
  const initial = setTimeout(() => { void sweepShadowYoutubeReels() }, 15000)
  initial.unref?.()
  monitor = setInterval(() => { void sweepShadowYoutubeReels() }, PULSE_INTERVAL)
  monitor.unref?.()
}
