import {
  studioTrendsSummary,
  studioSaveTopic,
  studioRemoveSavedTopic,
} from '../services/shadowStudioTrendsAnalytics.service.js'
import {
  readStudioChannelCache,
  invalidateStudioChannelCache,
} from '../services/shadowStudioChannelCache.service.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function ownerId(req, res) {
  const owner = String(req.user?.user_id || '')
  if (!UUID.test(owner)) {
    res.status(401).json({ ok: false, message: 'Sign in to view Studio trends.' })
    return null
  }
  return owner
}

function respondError(res, error, operation) {
  console.error(`[SHADOW_STUDIO_TRENDS_${operation}_ERROR]`, {
    code: error?.code || 'UNKNOWN',
    message: error?.message || 'Unknown error',
  })
  const missing = ['42P01', '42703', '42883', 'PGRST202', '42501'].includes(error?.code)
  const invalid = error instanceof TypeError || error?.code === '22023'
  return res.status(invalid ? 400 : missing ? 503 : 500).json({
    ok: false,
    code: invalid ? 'STUDIO_TRENDS_BAD_REQUEST' : missing ? 'STUDIO_TRENDS_NOT_INSTALLED' : 'STUDIO_TRENDS_UNAVAILABLE',
    message: invalid ? 'Invalid Studio trends request.' : missing ? 'Studio trends is not installed yet.' : 'Could not load Studio trends.',
  })
}

function topicFromBody(req, res) {
  const topic = req.body?.topic
  if (typeof topic !== 'string' || topic.length > 200 || topic.trim().length < 2) {
    res.status(400).json({ ok: false, code: 'STUDIO_TRENDS_BAD_TOPIC', message: 'A topic of 2 to 80 characters is required.' })
    return null
  }
  return topic
}

export async function getStudioTrends(req, res) {
  res.set('Cache-Control', 'private, no-store')
  const owner = ownerId(req, res)
  if (!owner) return
  const raw = req.query?.days ?? '30'
  if (typeof raw !== 'string' || !/^(7|28|30)$/.test(raw)) {
    return res.status(400).json({ ok: false, message: 'Invalid Studio trends period.' })
  }
  const days = Number(raw)
  try {
    const result = await readStudioChannelCache(
      { ownerId: owner, segment: `trends:${days}`, ttlMs: 6 * 60 * 60 * 1000 },
      () => studioTrendsSummary(owner, days),
    )
    return res.set('X-Studio-Cache', result.cached ? 'HIT' : 'MISS')
      .json({ ok: true, ...result.value })
  } catch (error) {
    return respondError(res, error, 'READ')
  }
}

export async function saveStudioTrendTopic(req, res) {
  res.set('Cache-Control', 'private, no-store')
  const owner = ownerId(req, res)
  if (!owner) return
  const topic = topicFromBody(req, res)
  if (!topic) return
  try {
    const result = await studioSaveTopic(owner, topic)
    if (result.ok === false) {
      return res.status(result.code === 'SAVED_TOPICS_LIMIT' ? 409 : 400).json(result)
    }
    invalidateStudioChannelCache(owner)
    return res.status(result.already_saved ? 200 : 201).json(result)
  } catch (error) {
    return respondError(res, error, 'SAVE')
  }
}

export async function removeStudioTrendTopic(req, res) {
  res.set('Cache-Control', 'private, no-store')
  const owner = ownerId(req, res)
  if (!owner) return
  const topic = topicFromBody(req, res)
  if (!topic) return
  try {
    const result = await studioRemoveSavedTopic(owner, topic)
    invalidateStudioChannelCache(owner)
    return res.json(result)
  } catch (error) {
    return respondError(res, error, 'REMOVE')
  }
}
