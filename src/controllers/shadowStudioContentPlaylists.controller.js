import { supabase } from '../config/supabase.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

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
    const { data, error } = await supabase.rpc('shadow_studio_playlist_active_page', {
      p_owner: userId,
      p_playlist: playlistId,
      p_limit: limit,
      p_offset: offset,
    })
    if (error) throw error
    if (data?.ok === false && data?.code === 'NOT_FOUND') {
      return res.status(404).json({ ok: false, message: 'Playlist not found' })
    }
    if (data?.ok !== true || !Array.isArray(data.videos) || !data.playlist || !data.pagination) {
      throw new Error('Invalid Playlist page response')
    }
    res.set('Cache-Control', 'private, no-store')
    return res.json({
      ok: true,
      playlist: data.playlist,
      videos: data.videos,
      pagination: data.pagination,
    })
  } catch (error) {
    console.error('SHADOW STUDIO PLAYLIST CONTENT ERROR:', {
      code: error?.code || 'UNKNOWN',
      message: error?.message || 'Unknown error',
    })
    return res.status(['42883', 'PGRST202'].includes(error?.code) ? 503 : 500)
      .json({ ok: false, message: 'Unable to load Playlist videos' })
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
