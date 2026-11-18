import {
  getAdminStoryAnalytics,
  searchAdminStoryAnalytics,
} from '../services/adminStoryAnalytics.service.js'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function failed(res, error, label) {
  if (error?.code === 'STORY_NOT_FOUND') {
    return res.status(404).json({ ok: false, code: error.code, message: 'Story not found' })
  }
  if (error?.code === 'INVALID_PERIOD') {
    return res.status(400).json({ ok: false, code: error.code, message: 'Invalid period' })
  }
  console.error(label, error)
  return res.status(500).json({ ok: false, message: 'Unable to load story analytics' })
}

export async function searchAdminStoryAnalyticsController(req, res) {
  res.set('Cache-Control', 'private, no-store')
  const query = String(req.query.q || '').trim()
  if (query.length > 100) {
    return res.status(400).json({ ok: false, message: 'Search is too long' })
  }
  if (query.length < 2) {
    return res.status(200).json({ ok: true, items: [] })
  }
  try {
    const result = await searchAdminStoryAnalytics(query, req.query.refresh === '1')
    return res.status(200).json(result)
  } catch (error) {
    return failed(res, error, 'ADMIN STORY ANALYTICS SEARCH ERROR:')
  }
}

export async function getAdminStoryAnalyticsController(req, res) {
  res.set('Cache-Control', 'private, no-store')
  const storyId = String(req.query.story_id || '').trim()
  const period = String(req.query.period || 'week').trim().toLowerCase()
  if (!UUID_PATTERN.test(storyId)) {
    return res.status(400).json({ ok: false, message: 'Invalid story ID' })
  }
  if (!['today', 'yesterday', 'week', 'month', 'year'].includes(period)) {
    return res.status(400).json({ ok: false, message: 'Invalid period' })
  }
  try {
    const result = await getAdminStoryAnalytics(storyId, period, req.query.refresh === '1')
    return res.status(200).json(result)
  } catch (error) {
    return failed(res, error, 'ADMIN STORY ANALYTICS ERROR:')
  }
}
