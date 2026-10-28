import { supabase } from '../config/supabase.js'

const CAMBODIA_OFFSET_MS = 7 * 60 * 60 * 1000
const ONE_DAY_MS = 24 * 60 * 60 * 1000
const SNAPSHOT_DAYS = 365

let cachedDay = ''
let cachedSnapshot = null
let inflight = null

function cambodiaToday() {
  return new Date(Date.now() + CAMBODIA_OFFSET_MS).toISOString().slice(0, 10)
}

function previousDay(day) {
  return new Date(Date.parse(`${day}T00:00:00Z`) - ONE_DAY_MS)
    .toISOString().slice(0, 10)
}

function validateSnapshot(data, today) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Story Growth RPC returned an invalid object')
  }
  if (data.as_of !== previousDay(today) || !Array.isArray(data.days)) {
    throw new Error('Story Growth RPC returned a stale or invalid snapshot')
  }
  if (data.days.length !== SNAPSHOT_DAYS) {
    throw new Error('Story Growth RPC returned an incomplete 365-day snapshot')
  }
  for (const row of data.days) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(row?.date || '') ||
        !Number.isSafeInteger(Number(row?.updated_stories)) ||
        !Number.isSafeInteger(Number(row?.new_episodes)) ||
        Number(row.updated_stories) < 0 || Number(row.new_episodes) < 0) {
      throw new Error('Story Growth RPC returned invalid daily counts')
    }
  }
}

async function loadDailyGrowth(today) {
  if (cachedDay === today && cachedSnapshot) return cachedSnapshot
  if (inflight?.day === today) return inflight.promise

  const promise = (async () => {
    const { data, error } = await supabase.rpc('get_admin_story_growth_daily')
    if (error) throw error
    validateSnapshot(data, today)
    const snapshot = {
      as_of: data.as_of,
      retention_days: SNAPSHOT_DAYS,
      days: data.days,
    }
    cachedDay = today
    cachedSnapshot = snapshot
    return snapshot
  })()

  inflight = { day: today, promise }
  try {
    return await promise
  } finally {
    if (inflight?.promise === promise) inflight = null
  }
}

export async function getAdminStoryGrowthDaily(_req, res) {
  const today = cambodiaToday()
  try {
    const snapshot = await loadDailyGrowth(today)
    // Admin-only endpoint; the UI handles its own per-day session cache.
    res.set('Cache-Control', 'private, no-store')
    return res.status(200).json({ ok: true, ...snapshot })
  } catch (error) {
    console.error('[ADMIN_STORY_GROWTH_DAILY]', {
      message: error?.message || 'Unknown error',
      code: error?.code || null,
      day: today,
    })
    res.set('Cache-Control', 'private, no-store')
    return res.status(500).json({
      ok: false,
      message: 'Failed to load Story Growth daily snapshot',
    })
  }
}
