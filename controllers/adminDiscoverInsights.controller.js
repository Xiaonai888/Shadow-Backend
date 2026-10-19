import { supabase } from '../config/supabase.js'

let cached = null
let cachedDay = ''
let pending = null

function cambodiaDay() {
  return new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

async function loadSnapshot() {
  const day = cambodiaDay()
  if (cached && cachedDay === day) return cached
  if (pending?.day === day) return pending.promise

  const promise = (async () => {
    const { data, error } = await supabase.rpc('get_admin_discover_insights_daily')
    if (error) throw error
    if (!data || !Array.isArray(data.days) || !/^\d{4}-\d{2}-\d{2}$/.test(data.as_of || '')) {
      throw new Error('Invalid Discover Insights daily snapshot')
    }
    cached = data
    cachedDay = day
    return data
  })().finally(() => {
    if (pending?.day === day) pending = null
  })

  pending = { day, promise }
  return promise
}

export async function getAdminDiscoverInsightsDaily(req, res) {
  try {
    const snapshot = await loadSnapshot()
    res.set('Cache-Control', 'private, max-age=300')
    return res.status(200).json(snapshot)
  } catch (error) {
    console.error('ADMIN_DISCOVER_INSIGHTS_DAILY_ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to load Promotion Insights' })
  }
}
