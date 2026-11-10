import { supabase } from '../config/supabase.js'

function unpack(result) {
  if (result.error) throw result.error
  const value = Array.isArray(result.data) ? result.data[0] : result.data
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid advanced analytics response.')
  }
  return value
}

export async function recordStudioWatch({ videoId, viewerId, sessionId, kind, playedSeconds }) {
  const result = await supabase.rpc('shadow_studio_record_watch', {
    p_video_id: videoId,
    p_viewer_id: viewerId,
    p_session_id: sessionId,
    p_kind: kind,
    p_played_seconds: playedSeconds,
  })
  return unpack(result)
}

export async function recordStudioThumbnail({ videoId, viewerId, surface, action }) {
  const result = await supabase.rpc('shadow_studio_record_thumbnail', {
    p_video_id: videoId,
    p_viewer_id: viewerId,
    p_surface: surface,
    p_action: action,
  })
  return unpack(result)
}

export async function readStudioAdvancedSummary({ ownerId, days = 30, format = 'all' }) {
  const result = await supabase.rpc('shadow_studio_advanced_summary', {
    p_owner: ownerId,
    p_days: days,
    p_format: format,
  })
  return unpack(result)
}
