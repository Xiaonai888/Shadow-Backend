import { supabase } from '../config/supabase.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function boundedInteger(value, defaultValue, maxValue) {
  if (value === undefined || value === null || value === '') return defaultValue
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) return null
  return Math.min(parsed, maxValue)
}

export async function listPublicFastVideos(req, res) {
  const limit = boundedInteger(req.query.limit, 8, 20)
  const offset = boundedInteger(req.query.offset, 0, 5000)
  const userId = String(req.query.user_id || '').trim()

  if (limit === null || limit === 0 || offset === null || (userId && !UUID.test(userId))) {
    return res.status(400).json({ ok: false, message: 'Invalid Fast query parameters' })
  }

  try {
    let query = supabase
      .from('fast_videos')
      .select('id,user_id,video_url,thumbnail_url,title,description,published_at')
      .eq('status', 'published')
      .eq('access_type', 'free')
      .eq('platform', 'youtube')

    if (userId) query = query.eq('user_id', userId)

    const { data, error } = await query
      .order('published_at', { ascending: false })
      .order('id', { ascending: false })
      .range(offset, offset + limit)

    if (error) throw error
    const rows = Array.isArray(data) ? data : []
    const videos = rows.slice(0, limit)

    res.set('Cache-Control', 'public, max-age=15, stale-while-revalidate=45')
    return res.json({
      ok: true,
      videos,
      pagination: {
        limit,
        offset,
        next_offset: offset + videos.length,
        has_more: rows.length > limit,
      },
    })
  } catch (error) {
    console.error('FAST PUBLIC FEED ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Unable to load Fast videos' })
  }
}
