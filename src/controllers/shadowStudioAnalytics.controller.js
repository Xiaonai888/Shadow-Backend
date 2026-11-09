import { studioDashboard, studioRanking, studioVideoAnalytics } from '../services/shadowStudioAnalytics.service.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function sendError(res, error, operation) {
  console.error(`[SHADOW_STUDIO_${operation}_ERROR]`, {
    code: error?.code || 'UNKNOWN',
    message: error?.message || 'Unknown error',
  })
  const notInstalled = ['42P01', '42703', '42883', 'PGRST202'].includes(error?.code)
  return res.status(notInstalled ? 503 : 500).json({
    ok: false,
    code: notInstalled ? 'STUDIO_ANALYTICS_NOT_INSTALLED' : 'STUDIO_ANALYTICS_UNAVAILABLE',
    message: notInstalled ? 'Shadow Studio analytics is not installed yet.' : 'Could not load Shadow Studio analytics.',
  })
}

function ownerId(req, res) {
  const id = req.user?.user_id
  if (!UUID.test(String(id || ''))) {
    res.status(401).json({ ok: false, message: 'Sign in to view Studio analytics.' })
    return null
  }
  return id
}

export async function getStudioDashboard(req, res) {
  const id = ownerId(req, res)
  if (!id) return
  try {
    const data = await studioDashboard(id)
    return res.set('Cache-Control', 'private, no-store').json({ ok: true, ...data })
  } catch (error) {
    return sendError(res, error, 'DASHBOARD')
  }
}

export async function getStudioVideoAnalytics(req, res) {
  const id = ownerId(req, res)
  if (!id) return
  const videoId = String(req.params.videoId || '')
  if (!UUID.test(videoId)) return res.status(400).json({ ok: false, message: 'Invalid video ID.' })
  try {
    const data = await studioVideoAnalytics(id, videoId)
    if (!data) return res.status(404).json({ ok: false, message: 'Published video not found.' })
    return res.set('Cache-Control', 'private, no-store').json({ ok: true, ...data })
  } catch (error) {
    return sendError(res, error, 'VIDEO')
  }
}

export async function getStudioRanking(req, res) {
  const id = ownerId(req, res)
  if (!id) return
  const videoId = String(req.query.video_id || '')
  if (!UUID.test(videoId)) return res.status(400).json({ ok: false, message: 'Invalid video ID.' })
  try {
    const data = await studioRanking(id, videoId)
    if (!data || !data.ranking.length) {
      return res.status(404).json({ ok: false, message: 'Eligible long video not found.' })
    }
    return res.set('Cache-Control', 'private, no-store').json({ ok: true, ...data })
  } catch (error) {
    return sendError(res, error, 'RANKING')
  }
}
