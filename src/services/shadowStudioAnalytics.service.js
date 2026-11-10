import { supabase } from '../config/supabase.js'

const VIDEO_FIELDS = 'id,title,video_url,thumbnail_url,published_at,view_count,video_type,duration_seconds,status,access_type'
const MISSING = { available: false, value: null }

function raise(error) {
  if (error) throw error
}

function scalar(value) {
  return Array.isArray(value) ? value[0] || null : value || null
}

function numericOrNull(value) {
  if (value == null) return null
  const number = Number(value)
  return Number.isSafeInteger(number) && number >= 0 ? number : null
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
  const [recent, window] = await Promise.all([
    supabase.from('fast_videos').select(VIDEO_FIELDS)
      .eq('user_id', ownerId).eq('status', 'published').eq('access_type', 'free')
      .not('published_at', 'is', null)
      .eq('video_type', 'long')
      .order('published_at', { ascending: false }).order('id', { ascending: false }).limit(3),
    supabase.rpc('shadow_studio_creator_30d_views', { p_owner: ownerId }),
  ])
  raise(recent.error)
  raise(window.error)
  const row = scalar(window.data)
  const videos = await Promise.all((recent.data || []).map(enriched))
  return {
    period_days: 30,
    coverage: coverage(row),
    channel: {
      views: row?.complete === true ? numericOrNull(row.period_views) : null,
      ...emptyMeasurements(),
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
  const video = await loadOwnerVideo(ownerId, videoId)
  if (!video) return null
  const { data, error } = await supabase.rpc('shadow_studio_rank_recent_long', {
    p_owner: ownerId,
    p_selected: videoId,
  })
  raise(error)
  const rows = Array.isArray(data) ? data : []
  const complete = rows.length > 0 && rows.every(row => row.comparable === true)
  return {
    selected_video_id: videoId,
    age_minutes: rows[0]?.age_minutes ?? null,
    comparison_complete: complete,
    ranking: rows.map(row => ({
      id: row.video_id,
      title: row.video_title,
      thumbnail_url: row.thumbnail,
      published_at: row.published_at,
      views_at_equal_age: complete ? numericOrNull(row.measured_views) : null,
      position: complete ? numericOrNull(row.rank_position) : null,
      highlighted: row.video_id === videoId,
    })),
  }
}
