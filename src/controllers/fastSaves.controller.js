import { supabase } from '../config/supabase.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Public aggregate only. No reader IDs or Saved Posts are exposed.
// GET /api/fast/videos/:id/saves
export async function getPublicFastSaveCount(req, res) {
  const videoId = String(req.params.id || '')
  if (!UUID.test(videoId)) {
    return res.status(400).json({ ok: false, message: 'Invalid Reel ID' })
  }

  try {
    const { data: reel, error: reelError } = await supabase
      .from('fast_videos')
      .select('id')
      .eq('id', videoId)
      .eq('status', 'published')
      .eq('access_type', 'free')
      .eq('platform', 'youtube')
      .maybeSingle()

    if (reelError) throw reelError
    if (!reel) return res.status(404).json({ ok: false, message: 'Reel not found' })

    const { count, error } = await supabase
      .from('saved_posts')
      .select('id', { head: true, count: 'exact' })
      .eq('source_type', 'fast_video')
      .eq('source_id', videoId)

    if (error) throw error
    res.set('Cache-Control', 'public, max-age=10, stale-while-revalidate=20')
    return res.json({ ok: true, video_id: videoId, save_count: Number(count ?? 0) })
  } catch (error) {
    console.error('[FAST_SAVE_COUNT_ERROR]', {
      code: error?.code || 'UNKNOWN',
      message: error?.message || 'Unknown error',
    })
    return res.status(500).json({
      ok: false,
      message: 'Unable to load Reel save count',
    })
  }
}
