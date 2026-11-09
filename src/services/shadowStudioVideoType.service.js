import { supabase } from '../config/supabase.js'

const VIDEO_COLUMNS = 'id,title,thumbnail_url,video_url,published_at,status,video_type,duration_seconds'

function isYouTubeShortsUrl(value) {
  try {
    const url = new URL(value)
    const host = url.hostname.toLowerCase()
    if (!['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(host)) return false
    return url.pathname.toLowerCase().startsWith('/shorts/')
  } catch {
    return false
  }
}

export async function listUnclassifiedStudioVideos(ownerId, limit, offset) {
  const { data, error } = await supabase
    .from('fast_videos')
    .select(VIDEO_COLUMNS)
    .eq('user_id', ownerId)
    .eq('platform', 'youtube')
    .is('video_type', null)
    .order('published_at', { ascending: false, nullsFirst: false })
    .order('id', { ascending: false })
    .range(offset, offset + limit)
  if (error) throw error
  const items = (data || []).slice(0, limit)
  return {
    videos: items.map(item => ({
      ...item,
      suggested_type: isYouTubeShortsUrl(item.video_url) ? 'short' : null,
    })),
    pagination: {
      limit,
      offset,
      next_offset: offset + items.length,
      has_more: (data || []).length > limit,
    },
  }
}

export async function setStudioVideoType(ownerId, videoId, videoType, durationSeconds) {
  const { data: existing, error: readError } = await supabase
    .from('fast_videos')
    .select('id,video_url,platform')
    .eq('user_id', ownerId)
    .eq('id', videoId)
    .maybeSingle()
  if (readError) throw readError
  if (!existing || existing.platform !== 'youtube') return null
  if (videoType === 'long' && isYouTubeShortsUrl(existing.video_url)) {
    const error = new Error('YouTube Shorts links cannot be classified as long videos.')
    error.status = 400
    throw error
  }
  const changes = { video_type: videoType }
  if (durationSeconds !== undefined) changes.duration_seconds = durationSeconds
  const { data, error } = await supabase
    .from('fast_videos')
    .update(changes)
    .eq('id', videoId)
    .eq('user_id', ownerId)
    .select(VIDEO_COLUMNS)
    .maybeSingle()
  if (error) throw error
  return data || null
}
