import { supabase } from '../config/supabase.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const PLAYLIST_FIELDS = 'id,name,is_public,created_at,updated_at'
const VIDEO_FIELDS = 'id,user_id,video_url,thumbnail_url,title,description,tags,status,access_type,unlock_price_diamonds,published_at,view_count,video_type,duration_seconds'

function pageValue(value, fallback, maximum) {
  if (value === undefined) return fallback
  const number = Number(value)
  return Number.isSafeInteger(number) && number >= 0 && number <= maximum ? number : null
}

export async function getMyStudioPlaylistVideos(req, res) {
  const userId = req.user?.user_id
  const playlistId = String(req.params.playlistId || '')
  if (!UUID.test(String(userId || ''))) {
    return res.status(401).json({ ok: false, message: 'Unauthorized' })
  }
  if (!UUID.test(playlistId)) {
    return res.status(400).json({ ok: false, message: 'Invalid Playlist ID' })
  }

  const limit = pageValue(req.query.limit, 12, 24)
  const offset = pageValue(req.query.offset, 0, 5000)
  if (limit === null || limit === 0 || offset === null) {
    return res.status(400).json({ ok: false, message: 'Invalid Playlist pagination' })
  }

  try {
    const { data: playlist, error: ownerError } = await supabase
      .from('fast_reel_playlists')
      .select(PLAYLIST_FIELDS)
      .eq('id', playlistId)
      .eq('user_id', userId)
      .maybeSingle()
    if (ownerError) throw ownerError
    if (!playlist) return res.status(404).json({ ok: false, message: 'Playlist not found' })

    const { data: membership, count, error: membersError } = await supabase
      .from('fast_reel_playlist_items')
      .select('video_id', { count: 'exact' })
      .eq('playlist_id', playlistId)
      .order('video_id', { ascending: false })
      .range(offset, offset + limit)
    if (membersError) throw membersError

    const entries = Array.isArray(membership) ? membership : []
    const videoIds = entries.slice(0, limit).map(row => row.video_id).filter(id => UUID.test(String(id || '')))
    let videos = []
    if (videoIds.length) {
      const { data, error } = await supabase
  .from('fast_videos')
  .select(VIDEO_FIELDS)
  .eq('user_id', userId)
  .eq('studio_state', 'active')
  .in('id', videoIds)
      if (error) throw error
      const byId = new Map((data || []).map(video => [video.id, video]))
      videos = videoIds.map(id => byId.get(id)).filter(Boolean)
    }

    const nextOffset = offset + Math.min(entries.length, limit)
    res.set('Cache-Control', 'private, no-store')
    return res.json({
      ok: true,
      playlist: {
        ...playlist,
        video_count: Number.isSafeInteger(count) ? count : null,
        thumbnail_url: offset === 0 ? videos[0]?.thumbnail_url || null : null,
      },
      videos,
      pagination: {
        limit,
        offset,
        next_offset: nextOffset,
        has_more: entries.length > limit,
        total: Number.isSafeInteger(count) ? count : null,
      },
    })
  } catch (error) {
    console.error('SHADOW STUDIO PLAYLIST CONTENT ERROR:', {
      code: error?.code || 'UNKNOWN',
      message: error?.message || 'Unknown error',
    })
    return res.status(500).json({ ok: false, message: 'Unable to load Playlist videos' })
  }
}

export async function getMyStudioPlaylistSummaries(req, res) {
  const userId = req.user?.user_id
  if (!UUID.test(String(userId || ''))) {
    return res.status(401).json({ ok: false, message: 'Unauthorized' })
  }
  if (typeof req.query.ids !== 'string') {
    return res.status(400).json({ ok: false, message: 'Invalid Playlist IDs' })
  }
  const ids = req.query.ids.split(',')
  if (ids.length < 1 || ids.length > 24 || ids.some(id => !UUID.test(id))) {
    return res.status(400).json({ ok: false, message: 'Invalid Playlist IDs' })
  }
  try {
    const { data, error } = await supabase.rpc('shadow_studio_playlist_summaries', {
      p_owner: userId,
      p_ids: [...new Set(ids)],
    })
    if (error) throw error
    res.set('Cache-Control', 'private, no-store')
    return res.json({ ok: true, summaries: Array.isArray(data) ? data : [] })
  } catch (error) {
    console.error('SHADOW STUDIO PLAYLIST SUMMARY ERROR:', {
      code: error?.code || 'UNKNOWN',
      message: error?.message || 'Unknown error',
    })
    return res.status(['42883', 'PGRST202'].includes(error?.code) ? 503 : 500)
      .json({ ok: false, message: 'Playlist summaries are unavailable' })
  }
}
