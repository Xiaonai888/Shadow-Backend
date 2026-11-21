import { supabase } from '../config/supabase.js'

const VIDEO_FIELDS = 'id,title,video_url,thumbnail_url,published_at,view_count,video_type,duration_seconds,status,access_type'
const MISSING = { available: false, value: null }
const THIRTY_DAYS_MS = 30 * 86400000

function raise(error) {
  if (error) throw error
}

function scalar(value) {
  return Array.isArray(value) ? value[0] || null : value || null
}

function numericOrNull(value) {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isSafeInteger(number) && number >= 0 ? number : null
}

function positiveMeasurementOrNull(value) {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : null
}

function coverage(row) {
  return {
    complete: row?.complete === true,
    started_at: row?.tracking_started_at || null,
    observed_views_since_tracking: numericOrNull(row?.observed_views),
  }
}

function emptyMeasurements() {
  return {
    watch_seconds: MISSING,
    thumbnail_impressions: MISSING,
    thumbnail_clicks: MISSING,
    thumbnail_ctr: MISSING,
    average_view_seconds: MISSING,
    audience_retention: MISSING,
    traffic_sources: MISSING,
    unique_viewers: MISSING,
  }
}

async function loadOwnerVideo(ownerId, videoId) {
  const { data, error } = await supabase.from('fast_videos')
    .select(VIDEO_FIELDS).eq('user_id', ownerId).eq('id', videoId)
    .eq('status', 'published').maybeSingle()
  raise(error)
  return data || null
}

async function countInteraction(table, videoId, visibleOnly = false) {
  try {
    let query = supabase.from(table)
      .select('video_id', { head: true, count: 'exact' }).eq('video_id', videoId)
    if (visibleOnly) query = query.is('deleted_at', null)
    const { count, error } = await query
    if (error) return null
    return numericOrNull(count)
  } catch {
    return null
  }
}

async function enriched(video) {
  const [likes, comments] = await Promise.all([
    countInteraction('fast_video_likes', video.id),
    countInteraction('fast_video_comments', video.id, true),
  ])
  return {
    ...video,
    view_count: numericOrNull(video.view_count),
    likes,
    comments,
  }
}

export async function studioDashboard(ownerId) {
  const [recent, window, advanced] = await Promise.all([
    supabase.from('fast_videos').select(VIDEO_FIELDS)
      .eq('user_id', ownerId).eq('status', 'published').eq('access_type', 'free')
      .not('published_at', 'is', null)
      .eq('studio_state', 'active')
      .eq('video_type', 'long')
      .not('video_url', 'ilike', '%/shorts/%')
      .order('published_at', { ascending: false }).order('id', { ascending: false }).limit(3),
    supabase.rpc('shadow_studio_creator_30d_views', { p_owner: ownerId }),
    supabase.rpc('shadow_studio_advanced_summary', { p_owner: ownerId, p_days: 30, p_format: 'all' }),
  ])
  raise(recent.error)
  if (window.error) console.warn('[SHADOW_STUDIO_DASHBOARD_VIEWS_UNAVAILABLE]', window.error.code || 'UNKNOWN')
  if (advanced.error) console.warn('[SHADOW_STUDIO_DASHBOARD_WATCH_UNAVAILABLE]', advanced.error.code || 'UNKNOWN')

  const row = window.error ? null : scalar(window.data)
  const measuredPeriodViews = numericOrNull(row?.period_views)
  const started = row?.tracking_started_at ? Date.parse(row.tracking_started_at) : NaN
  const isTrackingWithinPeriod = Number.isFinite(started) && started >= Date.now() - THIRTY_DAYS_MS
  const trackedViews = isTrackingWithinPeriod ? numericOrNull(row?.observed_views) : null
  const views = measuredPeriodViews ?? trackedViews
  const viewsBasis = measuredPeriodViews !== null
    ? row?.complete === true ? 'complete_30d' : 'observed_30d'
    : trackedViews !== null ? 'since_tracking_30d' : 'unavailable'

  const advancedRow = advanced.error ? null : scalar(advanced.data)
  const measuredWatchHours = advancedRow?.watch_time_hours?.available === true
    ? positiveMeasurementOrNull(advancedRow.watch_time_hours.value)
    : null
  const watchSeconds = measuredWatchHours === null ? null : measuredWatchHours * 3600
  const videos = await Promise.all((recent.data || []).map(enriched))

  return {
    period_days: 30,
    coverage: { ...coverage(row), views_basis: viewsBasis },
    channel: {
      views,
      views_basis: viewsBasis,
      ...emptyMeasurements(),
      watch_seconds: watchSeconds === null
        ? MISSING
        : { available: true, value: watchSeconds },
    },
    latest_long_videos: videos,
  }
}

export async function studioVideoAnalytics(ownerId, videoId) {
  const video = await loadOwnerVideo(ownerId, videoId)
  if (!video) return null
  const [window, days, hours] = await Promise.all([
    supabase.rpc('shadow_studio_video_30d_views', { p_owner: ownerId, p_video: videoId }),
    supabase.rpc('shadow_studio_video_daily_views', { p_owner: ownerId, p_video: videoId }),
    supabase.rpc('shadow_studio_video_hourly_views', { p_owner: ownerId, p_video: videoId }),
  ])
  raise(window.error)
  raise(days.error)
  raise(hours.error)
  const row = scalar(window.data)
  const startedAt = row?.tracking_started_at || null
  const publishedAt = video.published_at || null
  const startedMs = startedAt ? Date.parse(startedAt) : NaN
  const publishedMs = publishedAt ? Date.parse(publishedAt) : NaN
  const effectiveStart = Number.isFinite(publishedMs)
    ? Math.max(Date.now() - 30 * 86400000, publishedMs)
    : Date.now() - 30 * 86400000
  const complete30 = row?.complete === true && Number.isFinite(startedMs) && startedMs <= effectiveStart
  const complete48 = Number.isFinite(startedMs) && startedMs <= Math.max(Date.now() - 48 * 3600000, Number.isFinite(publishedMs) ? publishedMs : 0)
  return {
    video: await enriched(video),
    coverage: { ...coverage(row), video_30d_complete: complete30, video_48h_complete: complete48 },
    measured_views_30d: complete30 ? numericOrNull(row.period_views) : null,
    daily_views_utc: complete30 ? (days.data || []) : null,
    realtime_48h: complete48 ? (hours.data || []) : null,
    ...emptyMeasurements(),
  }
}

export async function studioRanking(ownerId, videoId) {
  const selected = await loadOwnerVideo(ownerId, videoId)
  if (!selected) return null

  const [recent, comparison] = await Promise.all([
    supabase.from('fast_videos').select(VIDEO_FIELDS)
      .eq('user_id', ownerId).eq('status', 'published').eq('access_type', 'free')
      .eq('studio_state', 'active').eq('video_type', 'long')
      .not('published_at', 'is', null)
      .not('video_url', 'ilike', '%/shorts/%')
      .order('published_at', { ascending: false }).order('id', { ascending: false }).limit(10),
    supabase.rpc('shadow_studio_rank_recent_long', { p_owner: ownerId, p_selected: videoId }),
  ])
  raise(recent.error)
  const videos = Array.isArray(recent.data) ? recent.data : []
  if (!videos.length) return null

  if (comparison.error) {
    console.warn('[SHADOW_STUDIO_RANKING_COMPARISON_UNAVAILABLE]', comparison.error.code || 'UNKNOWN')
  }
  const measured = !comparison.error && Array.isArray(comparison.data) ? comparison.data : []
  const byId = new Map(measured.map(row => [String(row.video_id), row]))
  const complete = numericOrNull(measured[0]?.age_minutes) !== null && measured.length >= videos.length && videos.every(video => {
    const row = byId.get(String(video.id))
    return row?.comparable === true && numericOrNull(row.measured_views) !== null
  })

  const ranked = videos.map(video => {
    const comparable = byId.get(String(video.id))
    const lifetime = numericOrNull(video.view_count)
    const sameAge = complete ? numericOrNull(comparable?.measured_views) : null
    return {
      id: video.id,
      title: video.title,
      thumbnail_url: video.thumbnail_url,
      published_at: video.published_at,
      view_count: lifetime,
      views_at_equal_age: sameAge,
      display_views: complete ? sameAge : lifetime,
      highlighted: String(video.id) === String(videoId),
    }
  })

  ranked.sort((a, b) => {
    const left = a.display_views
    const right = b.display_views
    if (left === null && right !== null) return 1
    if (right === null && left !== null) return -1
    if (left !== null && right !== null && left !== right) return right - left
    return new Date(b.published_at).getTime() - new Date(a.published_at).getTime() || String(b.id).localeCompare(String(a.id))
  })

  return {
    selected_video_id: videoId,
    age_minutes: complete ? numericOrNull(measured[0]?.age_minutes) : null,
    comparison_complete: complete,
    view_basis: complete ? 'equal_age' : 'lifetime',
    ranking: ranked.map((row, index) => ({ ...row, position: index + 1 })),
  }
}
