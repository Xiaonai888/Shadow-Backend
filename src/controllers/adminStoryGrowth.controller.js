import { supabase } from '../config/supabase.js'
import { getAdminStoryLanguage } from '../services/adminStoryLanguage.service.js'

const CAMBODIA_OFFSET_MS = 7 * 60 * 60 * 1000
const ONE_DAY_MS = 24 * 60 * 60 * 1000
const SNAPSHOT_DAYS = 365

const cachedSnapshots = new Map()
const inFlightSnapshots = new Map()

function cambodiaToday() {
  return new Date(Date.now() + CAMBODIA_OFFSET_MS).toISOString().slice(0, 10)
}

function previousDay(day) {
  return new Date(Date.parse(`${day}T00:00:00Z`) - ONE_DAY_MS).toISOString().slice(0, 10)
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

async function loadDailyGrowth(today, language) {
  const cached = cachedSnapshots.get(language)
  if (cached?.day === today) return cached.snapshot

  const running = inFlightSnapshots.get(language)
  if (running?.day === today) return running.promise

  const promise = (async () => {
    const { data, error } = language === 'all'
      ? await supabase.rpc('get_admin_story_growth_daily')
      : await supabase.rpc('get_admin_story_growth_language_daily', {
          p_language: language,
        })

    if (error) throw error
    validateSnapshot(data, today)

    if (language !== 'all' && data.language !== language) {
      throw new Error('Story Growth RPC returned the wrong language')
    }

    const snapshot = {
      language,
      as_of: data.as_of,
      retention_days: SNAPSHOT_DAYS,
      days: data.days,
    }

    cachedSnapshots.set(language, { day: today, snapshot })
    return snapshot
  })()

  inFlightSnapshots.set(language, { day: today, promise })

  try {
    return await promise
  } finally {
    if (inFlightSnapshots.get(language)?.promise === promise) {
      inFlightSnapshots.delete(language)
    }
  }
}

export async function getAdminStoryGrowthDaily(req, res) {
  const today = cambodiaToday()

  try {
    const language = getAdminStoryLanguage(req.query?.language || 'all')
    const snapshot = await loadDailyGrowth(today, language)

    res.set('Cache-Control', 'private, no-store')

    return res.status(200).json({
      ok: true,
      ...snapshot,
    })
  } catch (error) {
    const invalidLanguage = error?.status === 400

    if (!invalidLanguage) {
      console.error('[ADMIN_STORY_GROWTH_DAILY]', {
        message: error?.message || 'Unknown error',
        code: error?.code || null,
        day: today,
      })
    }

    res.set('Cache-Control', 'private, no-store')

    return res.status(invalidLanguage ? 400 : 500).json({
      ok: false,
      code: invalidLanguage
        ? 'INVALID_STORY_LANGUAGE'
        : 'ADMIN_STORY_GROWTH_FAILED',
      message: invalidLanguage
        ? 'Invalid Story Language'
        : 'Failed to load Story Growth daily snapshot',
    })
  }
}
