import { supabase } from '../config/supabase.js'

let cached = null
let cachedFor = ''
let running = null

async function loadVisitorGrowth(dayKey) {
  if (cached && cachedFor === dayKey) return cached
  if (!running) {
    running = (async () => {
      const { data, error } = await supabase.rpc('get_admin_visitor_growth_daily')
      if (error) throw error
      if (!data || !Array.isArray(data.days) || !/^\d{4}-\d{2}-\d{2}$/.test(data.as_of || '')) {
        throw new Error('Invalid visitor growth snapshot')
      }
      cached = data
      cachedFor = dayKey
      return data
    })().finally(() => {
      running = null
    })
  }
  await running
  return cachedFor === dayKey ? cached : loadVisitorGrowth(dayKey)
}

export async function getAdminVisitorGrowthDaily(req, res) {
  const dayKey = new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10)
  try {
    const data = await loadVisitorGrowth(dayKey)
    res.set('Cache-Control', 'private, no-store')
    return res.status(200).json({ ok: true, ...data })
  } catch (error) {
    console.error('ADMIN VISITOR GROWTH ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to load visitor growth' })
  }
}
