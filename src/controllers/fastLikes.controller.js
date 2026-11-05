import { supabase } from '../config/supabase.js'

// Shadow Fast Like system: intentionally separate from Post/Reaction tables.
// Expected SQL: public.fast_video_likes(video_id, user_id, created_at)
// with PRIMARY KEY (video_id, user_id) and FKs to fast_videos / users.

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function validUuid(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value)
}

function sendError(res, error, operation) {
  console.error(`[FAST_LIKES_${operation}_ERROR]`, {
    code: error?.code || 'UNKNOWN',
    message: error?.message || 'Unknown error',
  })

  return res.status(500).json({
    ok: false,
    code: 'FAST_LIKES_UNAVAILABLE',
    message: 'Unable to process Fast likes. Please try again.',
  })
}

async function findPublishedReel(videoId) {
  const { data, error } = await supabase
    .from('fast_videos')
    .select('id')
    .eq('id', videoId)
    .eq('status', 'published')
    .eq('access_type', 'free')
    .eq('platform', 'youtube')
    .maybeSingle()

  if (error) throw error
  return data
}

async function countLikes(videoId) {
  // PostgreSQL returns the exact count without sending every like row.
  const { count, error } = await supabase
    .from('fast_video_likes')
    .select('video_id', { head: true, count: 'exact' })
    .eq('video_id', videoId)

  if (error) throw error
  return Number(count ?? 0)
}

async function readerLiked(videoId, userId) {
  const { data, error } = await supabase
    .from('fast_video_likes')
    .select('video_id')
    .eq('video_id', videoId)
    .eq('user_id', userId)
    .maybeSingle()

  if (error) throw error
  return Boolean(data)
}

// Public summary: GET /api/fast/videos/:id/likes
export async function getFastVideoLikes(req, res) {
  const videoId = String(req.params.id || '')
  if (!validUuid(videoId)) {
    return res.status(400).json({ ok: false, message: 'Invalid Reel ID' })
  }

  try {
    const reel = await findPublishedReel(videoId)
    if (!reel) return res.status(404).json({ ok: false, message: 'Reel not found' })

    const likeCount = await countLikes(videoId)
    res.set('Cache-Control', 'no-store')
    return res.json({ ok: true, video_id: videoId, like_count: likeCount })
  } catch (error) {
    return sendError(res, error, 'COUNT')
  }
}

// Authenticated status: GET /api/fast/videos/:id/likes/me
// Route must use requireUser from user.middleware.js.
export async function getMyFastVideoLike(req, res) {
  const videoId = String(req.params.id || '')
  const userId = req.user?.user_id
  if (!validUuid(videoId)) {
    return res.status(400).json({ ok: false, message: 'Invalid Reel ID' })
  }
  if (!validUuid(userId)) {
    return res.status(401).json({ ok: false, message: 'Sign in to check your Like' })
  }

  try {
    const reel = await findPublishedReel(videoId)
    if (!reel) return res.status(404).json({ ok: false, message: 'Reel not found' })

    const [liked, likeCount] = await Promise.all([
      readerLiked(videoId, userId),
      countLikes(videoId),
    ])

    res.set('Cache-Control', 'private, no-store')
    return res.json({ ok: true, video_id: videoId, liked, like_count: likeCount })
  } catch (error) {
    return sendError(res, error, 'STATUS')
  }
}

// Idempotent Like/Unlike: PUT /api/fast/videos/:id/likes/me
// Body: { "liked": true } to Like, { "liked": false } to Unlike.
// Do not expose a public write route: requireUser must be applied in fast.routes.js.
export async function setMyFastVideoLike(req, res) {
  const videoId = String(req.params.id || '')
  const userId = req.user?.user_id
  const desiredLiked = req.body?.liked

  if (!validUuid(videoId)) {
    return res.status(400).json({ ok: false, message: 'Invalid Reel ID' })
  }
  if (!validUuid(userId)) {
    return res.status(401).json({ ok: false, message: 'Sign in to Like Reels' })
  }
  if (typeof desiredLiked !== 'boolean') {
    return res.status(400).json({
      ok: false,
      message: 'liked must be true or false',
    })
  }

  try {
    const reel = await findPublishedReel(videoId)
    if (!reel) return res.status(404).json({ ok: false, message: 'Reel not found' })

    if (desiredLiked) {
      // UNIQUE(video_id, user_id) + ignoreDuplicates protects against double Likes,
      // even if a reader double-taps or retries a failed HTTP request.
      const { error } = await supabase
        .from('fast_video_likes')
        .upsert(
          { video_id: videoId, user_id: userId },
          { onConflict: 'video_id,user_id', ignoreDuplicates: true },
        )
      if (error) throw error
    } else {
      const { error } = await supabase
        .from('fast_video_likes')
        .delete()
        .eq('video_id', videoId)
        .eq('user_id', userId)
      if (error) throw error
    }

    const [liked, likeCount] = await Promise.all([
      readerLiked(videoId, userId),
      countLikes(videoId),
    ])

    res.set('Cache-Control', 'private, no-store')
    return res.json({ ok: true, video_id: videoId, liked, like_count: likeCount })
  } catch (error) {
    // The Reel may have been deleted after the read but before the insert.
    if (error?.code === '23503') {
      return res.status(404).json({ ok: false, message: 'Reel not found' })
    }
    return sendError(res, error, 'WRITE')
  }
}
