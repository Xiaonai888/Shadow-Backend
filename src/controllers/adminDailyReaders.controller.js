import { supabase } from '../config/supabase.js'

let cached = null
let cachedFor = ''
let running = null

function getCambodiaDayKey() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Phnom_Penh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date())

  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${values.year}-${values.month}-${values.day}`
}

async function loadDailyReadersSnapshot(dayKey) {
  if (cached && cachedFor === dayKey) return cached

  if (!running) {
    running = (async () => {
      const { data, error } = await supabase.rpc('get_admin_daily_readers_snapshot')

      if (error) throw error

      if (!data || !Array.isArray(data.days) || !data.as_of) {
        throw new Error('Invalid daily readers snapshot')
      }

      cached = data
      cachedFor = dayKey
      return data
    })().finally(() => {
      running = null
    })
  }

  await running
  return cachedFor === dayKey ? cached : loadDailyReadersSnapshot(dayKey)
}

export async function getAdminDailyReaders(req, res) {
  const dayKey = getCambodiaDayKey()

  try {
    const data = await loadDailyReadersSnapshot(dayKey)

    res.set('Cache-Control', 'private, no-store')

    return res.status(200).json({
      ok: true,
      ...data,
    })
  } catch (error) {
    console.error('ADMIN DAILY READERS ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load daily readers',
    })
  }
}
