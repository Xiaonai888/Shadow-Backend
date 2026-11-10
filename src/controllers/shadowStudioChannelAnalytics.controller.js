import { readStudioChannelCache } from '../services/shadowStudioChannelCache.service.js'
import { studioChannelContent, studioChannelOverview } from '../services/shadowStudioChannelAnalytics.service.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const OVERVIEW_TTL_MS = 30 * 60 * 1000
const CONTENT_TTL_MS = 30 * 60 * 1000
const FORMATS = new Set(['all', 'videos', 'shorts'])

function getOwner(req, res) {
  const ownerId = req.user?.user_id
  if (!UUID.test(String(ownerId || ''))) {
    res.status(401).json({ ok: false, message: 'Sign in to view Studio analytics.' })
    return null
  }
  return ownerId
}

function sendError(res, error) {
  console.error('[SHADOW_STUDIO_CHANNEL_ANALYTICS_ERROR]', {
    code: error?.code || 'UNKNOWN',
    message: error?.message || 'Unknown error',
  })
  const unavailable = ['42P01', '42703', '42883', 'PGRST202'].includes(error?.code)
  return res.status(unavailable ? 503 : 500).json({
    ok: false,
    code: unavailable ? 'STUDIO_ANALYTICS_NOT_INSTALLED' : 'STUDIO_CHANNEL_ANALYTICS_UNAVAILABLE',
    message: unavailable ? 'Studio analytics is not installed yet.' : 'Could not load Studio analytics.',
  })
}

export async function getStudioChannelOverview(req, res) {
  res.set('Cache-Control', 'private, no-store')
  const ownerId = getOwner(req, res)
  if (!ownerId) return

  try {
    const { value, cached } = await readStudioChannelCache(
      { ownerId, segment: 'overview', ttlMs: OVERVIEW_TTL_MS },
      () => studioChannelOverview(ownerId),
    )
    return res.set('X-Studio-Cache', cached ? 'HIT' : 'MISS').json({ ok: true, ...value })
  } catch (error) {
    return sendError(res, error)
  }
}

export async function getStudioChannelContent(req, res) {
  res.set('Cache-Control', 'private, no-store')
  const ownerId = getOwner(req, res)
  if (!ownerId) return

  const format = String(req.query.format || 'all').toLowerCase()
  if (!FORMATS.has(format)) {
    return res.status(400).json({ ok: false, message: 'Unsupported Studio content format.' })
  }

  try {
    const { value, cached } = await readStudioChannelCache(
      { ownerId, segment: `content:${format}`, ttlMs: CONTENT_TTL_MS },
      () => studioChannelContent(ownerId, format),
    )
    return res.set('X-Studio-Cache', cached ? 'HIT' : 'MISS').json({ ok: true, ...value })
  } catch (error) {
    return sendError(res, error)
  }
}
