import { supabase } from '../config/supabase.js'

let cached = null
let cachedFor = ''
let running = null
let activityTrendCache = null
let activityTrendCachedFor = ''
let activityTrendRunning = null

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

function shiftDay(day, amount) {
  const date = new Date(`${day}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + amount)
  return date.toISOString().slice(0, 10)
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

async function loadReaderActivityTrend(dayKey) {
  if (activityTrendCache && activityTrendCachedFor === dayKey) {
    return activityTrendCache
  }

  if (!activityTrendRunning) {
    activityTrendRunning = (async () => {
      const startDay = shiftDay(dayKey, -30)
      const yesterday = shiftDay(dayKey, -1)
      const dailyUsers = new Map()
      const pageSize = 1000
      let offset = 0

      while (true) {
        const { data, error } = await supabase
          .from('reader_daily_activity')
          .select('activity_date, user_id')
          .gte('activity_date', startDay)
          .lt('activity_date', dayKey)
          .order('activity_date', { ascending: true })
          .order('user_id', { ascending: true })
          .range(offset, offset + pageSize - 1)

        if (error) throw error
        const rows = Array.isArray(data) ? data : []

        for (const row of rows) {
          const day = String(row.activity_date || '').slice(0, 10)
          const userId = String(row.user_id || '').trim()
          if (!day || !userId) continue
          if (!dailyUsers.has(day)) dailyUsers.set(day, new Set())
          dailyUsers.get(day).add(userId)
        }

        if (rows.length < pageSize) break
        offset += pageSize
      }

      const trackingSince = [...dailyUsers.keys()].sort()[0] || null
      const days = []

      if (trackingSince) {
        for (let day = trackingSince; day <= yesterday; day = shiftDay(day, 1)) {
          days.push({ date: day, readers: dailyUsers.get(day)?.size || 0 })
        }
      }

      const result = {
        as_of: yesterday,
        tracking_since: trackingSince,
        days,
        source: 'reader_daily_activity',
      }

      activityTrendCache = result
      activityTrendCachedFor = dayKey
      return result
    })().finally(() => {
      activityTrendRunning = null
    })
  }

  await activityTrendRunning
  return activityTrendCachedFor === dayKey
    ? activityTrendCache
    : loadReaderActivityTrend(dayKey)
}

export async function getAdminDailyReaders(req, res) {
  const dayKey = getCambodiaDayKey()

  try {
    const isActivityTrend = req.query.source === 'activity'
    const data = isActivityTrend
      ? await loadReaderActivityTrend(dayKey)
      : await loadDailyReadersSnapshot(dayKey)

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
