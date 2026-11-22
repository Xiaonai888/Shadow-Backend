import { Router } from 'express'
import { rateLimit } from 'express-rate-limit'
import { requireUser } from '../middleware/user.middleware.js'
import { supabase } from '../config/supabase.js'

const router = Router()
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const FIELDS = 'id,video_url,title,thumbnail_url,video_type,duration_seconds,view_count,published_at,youtube_health_checked_at,youtube_unavailable_since'
const limiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { ok: false, code: 'STUDIO_YOUTUBE_HEALTH_RATE_LIMITED' },
})

router.use(limiter, requireUser)

router.get('/unavailable/count', async (req, res) => {
  const owner = String(req.user?.user_id || '')
  if (!UUID.test(owner)) return res.status(401).json({ ok: false, message: 'Unauthorized' })
  try {
    const { count, error } = await supabase.from('fast_videos')
      .select('id', { head: true, count: 'exact' })
      .eq('user_id', owner)
      .eq('studio_state', 'active')
      .eq('youtube_health_state', 'unavailable')
    if (error) throw error
    res.set('Cache-Control', 'private, no-store')
    return res.json({ ok: true, count: count || 0 })
  } catch (error) {
    console.error('STUDIO_YOUTUBE_HEALTH_COUNT_ERROR', error?.message || 'unknown')
    return res.status(500).json({ ok: false, message: 'Could not load unavailable video count.' })
  }
})

router.get('/unavailable', async (req, res) => {
  const owner = String(req.user?.user_id || '')
  if (!UUID.test(owner)) return res.status(401).json({ ok: false, message: 'Unauthorized' })
  const limit = Number(req.query.limit ?? 12)
  const offset = Number(req.query.offset ?? 0)
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 24 ||
      !Number.isSafeInteger(offset) || offset < 0 || offset > 5000) {
    return res.status(400).json({ ok: false, message: 'Invalid pagination' })
  }
  try {
    const { data, error } = await supabase.from('fast_videos')
      .select(FIELDS)
      .eq('user_id', owner)
      .eq('studio_state', 'active')
      .eq('youtube_health_state', 'unavailable')
      .order('youtube_unavailable_since', { ascending: false })
      .order('id', { ascending: false })
      .range(offset, offset + limit)
    if (error) throw error
    const rows = data || []
    res.set('Cache-Control', 'private, no-store')
    return res.json({
      ok: true,
      videos: rows.slice(0, limit),
      pagination: { limit, offset, next_offset: offset + Math.min(rows.length, limit), has_more: rows.length > limit },
    })
  } catch (error) {
    console.error('STUDIO_YOUTUBE_HEALTH_LIST_ERROR', error?.message || 'unknown')
    return res.status(500).json({ ok: false, message: 'Could not load unavailable videos.' })
  }
})

export default router
