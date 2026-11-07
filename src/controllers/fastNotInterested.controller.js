import { supabase } from '../config/supabase.js'

// New Fast-only feedback table. Does not change Post reactions, Saves, or comments.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function reportDatabaseError(res, error, task) {
  console.error(`[FAST_NOT_INTERESTED_${task}]`, {
    code: error?.code || 'UNKNOWN',
    message: error?.message || 'Unknown database error',
  })
  return res.status(500).json({
    ok: false,
    code: 'FAST_NOT_INTERESTED_UNAVAILABLE',
    message: 'Unable to save Reel feedback right now.',
  })
}

// GET /api/fast/videos/not-interested/mine?limit=200&offset=0
// Called once when a signed-in reader opens Fast (paginated if needed).
export async function listMyFastNotInterested(req, res) {
  const userId = req.user?.user_id
  if (!UUID.test(String(userId || ''))) {
    return res.status(401).json({ ok: false, message: 'Reader account required' })
  }

  const limitInput = req.query.limit === undefined ? 200 : Number(req.query.limit)
  const offsetInput = req.query.offset === undefined ? 0 : Number(req.query.offset)
  if (
    !Number.isSafeInteger(limitInput) || limitInput < 1 || limitInput > 300 ||
    !Number.isSafeInteger(offsetInput) || offsetInput < 0 || offsetInput > 10000
  ) {
    return res.status(400).json({ ok: false, message: 'Invalid pagination' })
  }

  try {
    const { data, error } = await supabase
      .from('fast_video_not_interested')
      .select('video_id')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .order('video_id', { ascending: false })
      .range(offsetInput, offsetInput + limitInput)

    if (error) throw error
    const rows = data || []
    res.set('Cache-Control', 'private, no-store')
    return res.json({
      ok: true,
      video_ids: rows.slice(0, limitInput).map(row => row.video_id),
      pagination: {
        limit: limitInput,
        offset: offsetInput,
        next_offset: offsetInput + Math.min(rows.length, limitInput),
        has_more: rows.length > limitInput,
      },
    })
  } catch (error) {
    return reportDatabaseError(res, error, 'LIST')
  }
}

// PUT /api/fast/videos/:id/not-interested/me
// Body { not_interested: true } to hide; false to Undo.
// Idempotent and private: requires requireUser middleware.
export async function setMyFastNotInterested(req, res) {
  const userId = req.user?.user_id
  const videoId = String(req.params.id || '')
  const desired = req.body?.not_interested

  if (!UUID.test(String(userId || ''))) {
    return res.status(401).json({ ok: false, message: 'Reader account required' })
  }
  if (!UUID.test(videoId)) {
    return res.status(400).json({ ok: false, message: 'Invalid Reel ID' })
  }
  if (typeof desired !== 'boolean') {
    return res.status(400).json({ ok: false, message: 'not_interested must be boolean' })
  }

  try {
    if (desired) {
      const { data: reel, error: reelError } = await supabase
        .from('fast_videos')
        .select('id')
        .eq('id', videoId)
        .eq('status', 'published')
        .eq('access_type', 'free')
        .eq('platform', 'youtube')
        .maybeSingle()

      if (reelError) throw reelError
      if (!reel) {
        return res.status(404).json({ ok: false, message: 'Reel not found' })
      }

      const { error } = await supabase
        .from('fast_video_not_interested')
        .upsert(
          { user_id: userId, video_id: videoId },
          { onConflict: 'user_id,video_id', ignoreDuplicates: true },
        )
      if (error) throw error
    } else {
      // Undo works even after a video is unpublished or removed.
      const { error } = await supabase
        .from('fast_video_not_interested')
        .delete()
        .eq('user_id', userId)
        .eq('video_id', videoId)
      if (error) throw error
    }

    res.set('Cache-Control', 'private, no-store')
    return res.json({ ok: true, video_id: videoId, not_interested: desired })
  } catch (error) {
    if (error?.code === '23503') {
      return res.status(404).json({ ok: false, message: 'Reel not found' })
    }
    return reportDatabaseError(res, error, 'WRITE')
  }
}
