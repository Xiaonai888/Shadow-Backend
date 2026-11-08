// NEW: src/controllers/fastReelViews.controller.js
// Requires Supabase SQL migration 20261108_fast_reel_views.sql.
// Never trust a client-supplied view count: the database increments it atomically.
import { createHmac } from 'node:crypto'
import { supabase } from '../config/supabase.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function recordFastReelView(req, res) {
  const videoId = String(req.params.id || '').trim()
  const viewerId = req.body?.viewer_id

  if (!UUID.test(videoId) || typeof viewerId !== 'string' || !UUID.test(viewerId)) {
    return res.status(400).json({ ok: false, message: 'Invalid Reel view request.' })
  }

  const secret = process.env.FAST_REEL_VIEW_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!secret) {
    console.error('[FAST_REEL_VIEW_SECRET_MISSING]')
    return res.status(503).json({ ok: false, message: 'Reel view tracking unavailable.' })
  }

  try {
    // A random, stable browser UUID is hashed on the server; never store the raw UUID.
    const viewerHash = createHmac('sha256', secret)
      .update(`fast-reel-v1:browser:${viewerId.toLowerCase()}`)
      .digest('hex')
    const { data, error } = await supabase.rpc('record_fast_reel_play', {
      p_video_id: videoId,
      p_viewer_hash: viewerHash,
    })
    if (error) throw error

    const result = Array.isArray(data) ? data[0] : data
    res.set('Cache-Control', 'private, no-store')
    if (!result || result.total_views === null || result.total_views === undefined) {
      return res.status(404).json({ ok: false, message: 'Published Reel not found.' })
    }
    return res.json({
      ok: true,
      counted: Boolean(result.counted),
      view_count: Number(result.total_views),
    })
  } catch (error) {
    console.error('[FAST_REEL_VIEW_COUNT_ERROR]', { code: error?.code, message: error?.message })
    return res.status(500).json({ ok: false, message: 'Unable to record Reel playback.' })
  }
}
