import { supabase } from '../config/supabase.js'

function positiveInteger(value, fallback, max) {
  const number = Number.parseInt(value, 10)
  if (!Number.isFinite(number) || number < 1) return fallback
  return Math.min(number, max)
}

export async function getAdminMusicListens(req, res) {
  try {
    const page = positiveInteger(req.query.page, 1, 100000)
    const limit = positiveInteger(req.query.limit, 50, 100)
    const from = (page - 1) * limit
    const to = from + limit - 1

    let query = supabase
      .from('music_listens')
      .select(
        `
          id,
          user_id,
          song_id,
          listened_seconds,
          counted_view,
          created_at,
          user:users (
            id,
            name,
            username,
            avatar_url
          ),
          song:music_songs (
            id,
            title,
            view_count,
            artist:music_artists (
              id,
              name
            ),
            release:music_releases (
              id,
              title,
              release_type
            )
          )
        `,
        { count: 'exact' }
      )
      .order('created_at', { ascending: false })
      .range(from, to)

    const userId = String(req.query.user_id || '').trim()
    const songId = String(req.query.song_id || '').trim()

    if (userId) query = query.eq('user_id', userId)
    if (songId) query = query.eq('song_id', songId)

    const { data, error, count } = await query

    if (error) throw error

    const listens = (Array.isArray(data) ? data : []).map((item) => ({
      id: item.id,
      user_id: item.user_id,
      song_id: item.song_id,
      listened_seconds: Number(item.listened_seconds || 0),
      counted_view: Boolean(item.counted_view),
      created_at: item.created_at,
      user: item.user
        ? {
            id: item.user.id,
            name: item.user.name || '',
            username: item.user.username || '',
            avatar_url: item.user.avatar_url || null,
          }
        : null,
      song: item.song
        ? {
            id: item.song.id,
            title: item.song.title || '',
            view_count: Number(item.song.view_count || 0),
            artist: item.song.artist
              ? {
                  id: item.song.artist.id,
                  name: item.song.artist.name || '',
                }
              : null,
            release: item.song.release
              ? {
                  id: item.song.release.id,
                  title: item.song.release.title || '',
                  release_type: item.song.release.release_type || 'single',
                }
              : null,
          }
        : null,
    }))

    return res.json({
      ok: true,
      listens,
      pagination: {
        page,
        limit,
        total: Number(count || 0),
        has_more: from + listens.length < Number(count || 0),
      },
    })
  } catch (error) {
    console.error('GET ADMIN MUSIC LISTENS ERROR:', error)
    return res.status(500).json({
      ok: false,
      message: error.message || 'Failed to load music listen history',
    })
  }
}
