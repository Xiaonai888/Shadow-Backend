import {
  readStudioAdvancedSummary,
  recordStudioThumbnail,
  recordStudioWatch,
} from '../services/shadowStudioAdvancedMetrics.service.js'
import { readStudioChannelCache } from '../services/shadowStudioChannelCache.service.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const FORMATS = new Set(['all', 'videos', 'shorts'])
const DAYS = new Set([7, 28, 30])
const KINDS = new Set(['start', 'progress', 'end'])
const SURFACES = new Set(['search', 'discover', 'profile', 'author', 'related'])
const ACTIONS = new Set(['impression', 'click'])

function viewerId(req, res) {
  const id = String(req.user?.user_id || '')
  if (!UUID.test(id)) {
    res.status(401).json({ ok: false, message: 'Sign in to use Studio tracking.' })
    return null
  }
  return id
}

function failure(res, error) {
  console.error('[STUDIO_ADVANCED_METRICS_ERROR]', {
    code: error?.code || 'UNKNOWN',
    message: error?.message || 'Unknown error',
  })
  const missing = ['42P01', '42703', '42883', 'PGRST202'].includes(error?.code)
  return res.status(missing ? 503 : 500).json({
    ok: false,
    code: missing ? 'STUDIO_ADVANCED_METRICS_NOT_INSTALLED' : 'STUDIO_ADVANCED_METRICS_UNAVAILABLE',
    message: missing ? 'Studio advanced metrics have not been installed.' : 'Could not process Studio advanced metrics.',
  })
}

export async function postStudioWatch(req, res) {
  res.set('Cache-Control', 'private, no-store')
  const id = viewerId(req, res)
  if (!id) return
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}
  const videoId = String(body.video_id || '')
  const sessionId = String(body.session_id || '')
  const kind = body.kind
  const playedSeconds = body.played_seconds
  if (!UUID.test(videoId) || !UUID.test(sessionId) || !KINDS.has(kind)
    || typeof playedSeconds !== 'number' || !Number.isFinite(playedSeconds)
    || playedSeconds < 0 || playedSeconds > 43200
    || (kind === 'start' && playedSeconds !== 0)) {
    return res.status(400).json({ ok: false, message: 'Invalid Studio playback event.' })
  }
  try {
    const result = await recordStudioWatch({ videoId, viewerId: id, sessionId, kind, playedSeconds })
    return res.status(result.ok ? 200 : result.reason === 'session_not_started' ? 409 : 404).json(result)
  } catch (error) {
    return failure(res, error)
  }
}

export async function postStudioThumbnail(req, res) {
  res.set('Cache-Control', 'private, no-store')
  const id = viewerId(req, res)
  if (!id) return
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}
  const videoId = String(body.video_id || '')
  if (!UUID.test(videoId) || !SURFACES.has(body.surface) || !ACTIONS.has(body.action)) {
    return res.status(400).json({ ok: false, message: 'Invalid Studio thumbnail event.' })
  }
  try {
    const result = await recordStudioThumbnail({
      videoId, viewerId: id, surface: body.surface, action: body.action,
    })
    return res.status(result.ok ? 200 : result.reason === 'impression_required' ? 409 : 404).json(result)
  } catch (error) {
    return failure(res, error)
  }
}

export async function getStudioAdvancedSummary(req, res) {
  res.set('Cache-Control', 'private, no-store')
  const id = viewerId(req, res)
  if (!id) return
  const days = Number(req.query.days ?? 30)
  const format = String(req.query.format || 'all').toLowerCase()
  if (!DAYS.has(days) || !FORMATS.has(format)) {
    return res.status(400).json({ ok: false, message: 'Invalid Studio summary filters.' })
  }
  try {
    const { value, cached } = await readStudioChannelCache(
      { ownerId: id, segment: `advanced:${days}:${format}`, ttlMs: 30 * 60 * 1000 },
      () => readStudioAdvancedSummary({ ownerId: id, days, format }),
    )
    return res.set('X-Studio-Cache', cached ? 'HIT' : 'MISS').json({ ok: true, ...value })
  } catch (error) {
    return failure(res, error)
  }
}
