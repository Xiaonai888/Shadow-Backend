import { supabase } from '../config/supabase.js'

const cache = new Map()
const pending = new Map()
const MAX_ENTRIES = 120
const SEARCH_TTL = 10 * 60 * 1000
const TODAY_TTL = 2 * 60 * 1000
const LIVE_TTL = 5 * 60 * 1000
const HISTORY_TTL = 30 * 24 * 60 * 60 * 1000

const khDate = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Phnom_Penh',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

function getCambodiaDay() {
  const parts = Object.fromEntries(khDate.formatToParts(new Date()).map((part) => [part.type, part.value]))
  return `${parts.year}-${parts.month}-${parts.day}`
}

function prune() {
  const now = Date.now()
  for (const [key, value] of cache) {
    if (value.expiresAt <= now) cache.delete(key)
  }
  while (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value)
}

async function cachedRequest(key, ttlFor, run, refresh = false) {
  prune()
  const found = cache.get(key)
  if (!refresh && found && found.expiresAt > Date.now()) return found.data
  if (pending.has(key)) return pending.get(key)

  const promise = (async () => {
    const data = await run()
    if (!data || data.ok !== true) {
      const error = new Error(data?.code || 'Invalid story analytics response')
      error.code = data?.code || 'INVALID_ANALYTICS_RESPONSE'
      throw error
    }
    const ttl = ttlFor(data)
    prune()
    cache.set(key, { data, expiresAt: Date.now() + ttl })
    return data
  })()

  pending.set(key, promise)
  try {
    return await promise
  } finally {
    if (pending.get(key) === promise) pending.delete(key)
  }
}

export function searchAdminStoryAnalytics(query, refresh = false) {
  const cleaned = String(query || '').trim().slice(0, 100)
  const key = `search:${cleaned.toLocaleLowerCase()}`
  return cachedRequest(key, () => SEARCH_TTL, async () => {
    const { data, error } = await supabase.rpc('get_admin_story_analytics_search_v1', {
      p_query: cleaned,
      p_limit: 10,
    })
    if (error) throw error
    if (!Array.isArray(data?.items)) throw new Error('Invalid story search results')
    return data
  }, refresh)
}

export function getAdminStoryAnalytics(storyId, period, refresh = false) {
  const day = getCambodiaDay()
  const key = `report:${day}:${storyId}:${period}`
  return cachedRequest(key, (data) => {
    if (period === 'yesterday') return data.snapshot_complete ? HISTORY_TTL : TODAY_TTL
    if (period === 'today') return TODAY_TTL
    return LIVE_TTL
  }, async () => {
    const { data, error } = await supabase.rpc('get_admin_story_analytics_v1', {
      p_story_id: storyId,
      p_period: period,
    })
    if (error) throw error
    if (!Array.isArray(data?.buckets) && data?.ok === true) {
      throw new Error('Invalid story analytics buckets')
    }
    return data
  }, refresh)
}
