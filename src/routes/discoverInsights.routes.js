import express from 'express'
import jwt from 'jsonwebtoken'
import { createHmac } from 'node:crypto'
import { supabase } from '../config/supabase.js'
import { createRateLimit } from '../middleware/rateLimit.middleware.js'
import { requireAdmin } from '../middleware/auth.middleware.js'
import { getAdminDiscoverInsightsDaily } from '../controllers/adminDiscoverInsights.controller.js'

const router = express.Router()
const genderCache = new Map()
const GENDER_CACHE_MS = 6 * 60 * 60 * 1000
const rateLimit = createRateLimit({
  key: 'discover_insights_events',
  windowMs: 60000,
  max: 90,
})

function normalizedGender(value) {
  const gender = String(value || '').trim().toLowerCase()
  if (gender === 'female') return 'female'
  if (gender === 'male') return 'male'
  if (gender === 'other' || gender === 'custom' || gender === 'non-binary') return 'other'
  return 'unknown'
}

async function getVerifiedGender(req) {
  const authorization = String(req.headers.authorization || '')
  if (!authorization.startsWith('Bearer ')) return 'unknown'

  let userId
  try {
    const claims = jwt.verify(authorization.slice(7), process.env.JWT_SECRET)
    if (claims?.type !== 'reader') return 'unknown'
    userId = String(claims.user_id || '')
  } catch {
    return 'unknown'
  }

  if (!/^[0-9a-fA-F-]{36}$/.test(userId)) return 'unknown'
  const now = Date.now()
  const cached = genderCache.get(userId)
  if (cached && cached.expiresAt > now) return cached.gender

  const { data, error } = await supabase
    .from('users')
    .select('gender')
    .eq('id', userId)
    .maybeSingle()

  if (error) return 'unknown'
  const gender = normalizedGender(data?.gender)
  if (genderCache.size >= 5000) genderCache.delete(genderCache.keys().next().value)
  genderCache.set(userId, { gender, expiresAt: now + GENDER_CACHE_MS })
  return gender
}

router.post('/events', rateLimit, async (req, res) => {
  try {
    if (/bot|crawler|spider|headless|phantom|python|curl|wget|scrapy|httpclient/i.test(String(req.get('user-agent') || ''))) {
      return res.status(202).json({ ok: true, skipped: true })
    }

    const body = req.body || {}
    const visitorId = String(body.visitor_id || '').trim()
    const visitCount = Number(body.visit_count ?? 1)
    const rawPromotions = body.promotions ?? []

    if (
      !/^[a-zA-Z0-9_-]{16,128}$/.test(visitorId) ||
      !Number.isInteger(visitCount) ||
      visitCount < 1 || visitCount > 100 ||
      !Array.isArray(rawPromotions) || rawPromotions.length > 12
    ) {
      return res.status(400).json({ ok: false, message: 'Invalid analytics event' })
    }

    const promotionsById = new Map()
    for (const item of rawPromotions) {
      const id = Number(item?.promotion_id)
      if (!Number.isSafeInteger(id) || id < 1) {
        return res.status(400).json({ ok: false, message: 'Invalid promotion id' })
      }
      const previous = promotionsById.get(id) || { promotion_id: id, viewed: false, clicked: false }
      previous.clicked = previous.clicked || item.clicked === true
      previous.viewed = previous.viewed || item.viewed === true || previous.clicked
      promotionsById.set(id, previous)
    }

    const promotions = Array.from(promotionsById.values())
    const nowKh = new Date(Date.now() + 7 * 60 * 60 * 1000)
    const visitorKey = createHmac('sha256', process.env.JWT_SECRET)
      .update(`discover-insights:v1:${visitorId}`)
      .digest('hex')

    const { error } = await supabase.rpc('record_discover_insights_events', {
      p_day: nowKh.toISOString().slice(0, 10),
      p_visitor_key: visitorKey,
      p_first_visit_hour: nowKh.getUTCHours(),
      p_visit_count: visitCount,
      p_quality_view: body.quality_view === true || promotions.some(item => item.clicked),
      p_gender: await getVerifiedGender(req),
      p_promotions: promotions,
    })

    if (error) throw error
    res.set('Cache-Control', 'no-store')
    return res.status(202).json({ ok: true })
  } catch (error) {
    console.error('DISCOVER_INSIGHTS_RECORD_ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Could not record analytics event' })
  }
})

router.get('/admin/daily', requireAdmin, getAdminDiscoverInsightsDaily)

export default router
