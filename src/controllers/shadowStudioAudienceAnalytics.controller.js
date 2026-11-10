import { studioAudienceSummary } from '../services/shadowStudioAudienceAnalytics.service.js'
import { readStudioChannelCache } from '../services/shadowStudioChannelCache.service.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const PERIODS = new Set([7, 28, 30])

export async function getStudioAudienceSummary(req, res) {
  res.set('Cache-Control', 'private, no-store')
  const ownerId = String(req.user?.user_id || '')
  if (!UUID.test(ownerId)) {
    return res.status(401).json({ ok: false, message: 'Sign in to view Studio audience analytics.' })
  }

  const daysRaw = req.query?.days ?? '30'
  const days = typeof daysRaw === 'string' && /^(7|28|30)$/.test(daysRaw)
    ? Number(daysRaw) : NaN
  if (!PERIODS.has(days)) {
    return res.status(400).json({ ok: false, message: 'Invalid audience period.' })
  }

  try {
    const result = await readStudioChannelCache(
      { ownerId, segment: `audience:${days}`, ttlMs: 60 * 60 * 1000 },
      () => studioAudienceSummary(ownerId, days),
    )
    return res.set('X-Studio-Cache', result.cached ? 'HIT' : 'MISS')
      .json({ ok: true, ...result.value })
  } catch (error) {
    console.error('[SHADOW_STUDIO_AUDIENCE_ERROR]', {
      code: error?.code || 'UNKNOWN',
      message: error?.message || 'Unknown error',
    })
    const missing = ['42P01', '42703', '42883', 'PGRST202', '42501'].includes(error?.code)
    return res.status(missing ? 503 : 500).json({
      ok: false,
      code: missing ? 'STUDIO_AUDIENCE_NOT_INSTALLED' : 'STUDIO_AUDIENCE_UNAVAILABLE',
      message: missing ? 'Studio audience analytics is not installed yet.' : 'Could not load Studio audience analytics.',
    })
  }
}
