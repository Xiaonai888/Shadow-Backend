import { supabase } from '../config/supabase.js'

let cached = null
let cachedFor = ''
let running = null

async function loadGrowthSnapshot(dayKey) {
  if (cached && cachedFor === dayKey) return cached

  if (!running) {
    running = (async () => {
      const { data, error } = await supabase.rpc('get_admin_reader_growth_daily')
      if (error) throw error
      if (!data || !Array.isArray(data.days) || !data.as_of) {
        throw new Error('Invalid reader growth snapshot')
      }
      cached = data
      cachedFor = dayKey
      return data
    })().finally(() => {
      running = null
    })
  }

  await running
  return cachedFor === dayKey ? cached : loadGrowthSnapshot(dayKey)
}

export async function getAdminReaderGrowthDaily(req, res) {
  const dayKey = new Date(Date.now() + 390 * 60_000).toISOString().slice(0, 10)

  try {
    const data = await loadGrowthSnapshot(dayKey)
    res.set('Cache-Control', 'private, no-store')
    return res.status(200).json({ ok: true, ...data })
  } catch (error) {
    console.error('ADMIN READER GROWTH ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to load reader growth' })
  }
}
