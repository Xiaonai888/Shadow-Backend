import { supabase } from '../config/supabase.js'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export async function recordMusicListen(req, res) {
  try {
    const userId = String(req.user?.user_id || '').trim()
    const songId = String(req.params.songId || '').trim()

    if (!UUID_PATTERN.test(userId) || !UUID_PATTERN.test(songId)) {
      return res.status(400).json({ ok: false, message: 'Invalid user or song ID' })
    }

    const { data, error } = await supabase.rpc('record_music_listen', {
      p_user_id: userId,
      p_song_id: songId,
      p_listened_seconds: 5,
    })

    if (error) throw error

    const result = Array.isArray(data) ? data[0] : data

    if (!result) {
      return res.status(404).json({ ok: false, message: 'Music song not found' })
    }

    return res.json({
      ok: true,
      counted: Boolean(result.counted),
      view_count: Number(result.current_view_count || 0),
    })
  } catch (error) {
    console.error('RECORD MUSIC LISTEN ERROR:', error)
    return res.status(500).json({
      ok: false,
      message: error.message || 'Failed to record music listen',
    })
  }
}
