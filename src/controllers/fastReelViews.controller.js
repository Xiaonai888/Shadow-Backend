// NEW: src/controllers/fastReelViews.controller.js
// Requires Supabase SQL migration 20261108_fast_reel_views.sql.
// Never trust a client-supplied view count: the database increments it atomically.
import { createHmac } from 'node:crypto'
import { supabase } from '../config/supabase.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

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

// Stage 2: authenticated, per-account daily view counting.
// Wire this handler to a NEW requireUser-protected /videos/:id/view/v2 route.
// Do not replace the legacy view route until the Fast client switches to V2.
export async function recordFastReelViewV2(req, res) {
  res.set('Cache-Control', 'private, no-store')
  const userId = req.user?.user_id
  const videoId = String(req.params.id || '').trim()
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
    ? req.body : {}
  const mode = body.mode

  if (!userId || !UUID.test(String(userId))) {
    return res.status(401).json({ ok: false, message: 'Reader login required to count Reel views.' })
  }
  if (!UUID.test(videoId) || (mode !== 'fast' && mode !== 'qualified')) {
    return res.status(400).json({ ok: false, message: 'Invalid Reel view request.' })
  }

  let watchedSeconds = 0
  let durationSeconds = null
  if (mode === 'qualified') {
    watchedSeconds = body.watched_seconds
    durationSeconds = body.video_duration_seconds
    if (
      typeof watchedSeconds !== 'number' || !Number.isFinite(watchedSeconds) ||
      typeof durationSeconds !== 'number' || !Number.isFinite(durationSeconds) ||
      watchedSeconds < 0 || durationSeconds <= 0 || durationSeconds > 43200 ||
      watchedSeconds > durationSeconds + 1
    ) {
      return res.status(400).json({ ok: false, message: 'Valid playback duration and watched seconds are required.' })
    }
  }

  try {
    // Atomic validation, Cambodia day reset, configurable cooldown and increment are in SQL.
    const { data, error } = await supabase.rpc('record_fast_reel_play_v2', {
      p_user_id: userId,
      p_video_id: videoId,
      p_mode: mode,
      p_watched_seconds: watchedSeconds,
      p_video_duration_seconds: durationSeconds,
    })
    if (error) throw error
    const result = Array.isArray(data) ? data[0] : data
    if (!result || result.total_views == null) {
      return res.status(404).json({ ok: false, message: 'Published free Reel not found.' })
    }
    const total = Number(result.total_views)
    if (!Number.isSafeInteger(total) || total < 0) {
      throw new Error('Invalid total_views returned by view RPC')
    }
    return res.json({
      ok: true,
      counted: result.counted === true,
      view_count: total,
      reason: String(result.reason || ''),
      fast_used: Number(result.fast_used || 0),
      fast_remaining: Number(result.fast_remaining || 0),
      requires_qualified_view: result.requires_qualified_view === true,
    })
  } catch (error) {
    console.error('[FAST_REEL_VIEW_V2_ERROR]', { code: error?.code, message: error?.message })
    const migrationMissing = ['PGRST202', '42883', '42501'].includes(error?.code)
    return res.status(migrationMissing ? 503 : 500).json({
      ok: false,
      message: migrationMissing ? 'Reel view V2 is not available yet.' : 'Unable to record Reel playback.',
    })
  }
}
