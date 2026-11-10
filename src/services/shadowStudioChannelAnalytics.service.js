import { supabase } from '../config/supabase.js'

const VIDEO_FIELDS = 'id,title,thumbnail_url,video_url,published_at,view_count,video_type,duration_seconds'
const PERIOD_DAYS = 30
const TOP_LIMIT = 5
const MISSING = Object.freeze({ available: false, value: null })

function safeCount(value) {
  if (value === null || value === undefined || value === '') return null
  const count = Number(value)
  return Number.isSafeInteger(count) && count >= 0 ? count : null
}

function firstRow(value) {
  return Array.isArray(value) ? value[0] || null : value || null
}

function assertQuery(result) {
  if (result.error) throw result.error
  return result
}

function formatVideo(row) {
  return {
    id: row.id,
    title: row.title,
    thumbnail_url: row.thumbnail_url,
    video_url: row.video_url,
    published_at: row.published_at,
    video_type: row.video_type,
    duration_seconds: row.duration_seconds,
    lifetime_views: safeCount(row.view_count),
  }
}

async function loadTopVideos(ownerId, videoType = null) {
  let query = supabase.from('fast_videos')
    .select(VIDEO_FIELDS, { count: 'exact' })
    .eq('user_id', ownerId)
    .eq('status', 'published')
    .eq('access_type', 'free')
    .not('published_at', 'is', null)

  if (videoType) query = query.eq('video_type', videoType)

  const result = assertQuery(await query
    .order('view_count', { ascending: false, nullsFirst: false })
    .order('id', { ascending: false })
    .limit(TOP_LIMIT))

  return {
    total_published: safeCount(result.count),
    ranked_by: 'lifetime_views',
    items: (result.data || []).map(formatVideo),
  }
}

export async function studioChannelOverview(ownerId) {
  const [periodResult, topContent] = await Promise.all([
    supabase.rpc('shadow_studio_creator_30d_views', { p_owner: ownerId }),
    loadTopVideos(ownerId),
  ])

  assertQuery(periodResult)
  const row = firstRow(periodResult.data)
  const complete = row?.complete === true

  return {
    period_days: PERIOD_DAYS,
    generated_at: new Date().toISOString(),
    coverage: {
      complete,
      tracking_started_at: row?.tracking_started_at || null,
      observed_views_since_tracking: safeCount(row?.observed_views),
    },
    views: { available: complete && safeCount(row?.period_views) !== null, value: complete ? safeCount(row?.period_views) : null },
    watch_time_hours: MISSING,
    net_followers: MISSING,
    realtime_48h: { available: false, hours: null, total_views: null },
    top_content: topContent,
  }
}

export async function studioChannelContent(ownerId, format = 'all') {
  const videoType = format === 'videos' ? 'long' : format === 'shorts' ? 'short' : null
  const content = await loadTopVideos(ownerId, videoType)

  return {
    format,
    generated_at: new Date().toISOString(),
    top_content: content,
    views_30d: MISSING,
    impressions_30d: MISSING,
    thumbnail_ctr_30d: MISSING,
    engaged_views_30d: MISSING,
    audience_retention: MISSING,
    traffic_sources: MISSING,
  }
}
