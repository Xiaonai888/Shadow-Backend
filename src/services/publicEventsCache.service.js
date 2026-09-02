import { supabase } from '../config/supabase.js'

const CACHE_TTL_MS = 10 * 60 * 1000

let sharedCache = null
let sharedCacheExpiresAt = 0
let sharedCacheRequest = null
let sharedCacheGeneration = 0

function asTime(value) {
  return new Date(value || 0).getTime()
}

function filterActiveEvents(rows, nowMs) {
  return (Array.isArray(rows) ? rows : []).filter((event) => {
    if (!event?.is_published) return false

    const startsAt = asTime(event.starts_at)
    const endsAt = asTime(event.ends_at)

    return (
      Number.isFinite(startsAt) &&
      Number.isFinite(endsAt) &&
      startsAt <= nowMs &&
      endsAt > nowMs
    )
  })
}

async function loadPublishedEvents(nowIso) {
  const { data, error } = await supabase
    .from('shadow_events')
    .select(
      'id, title, description, badge_text, image_url, image_storage_key, button_text, button_url, starts_at, ends_at, sort_order, is_published, created_at, updated_at'
    )
    .eq('is_published', true)
    .gt('ends_at', nowIso)
    .order('sort_order', { ascending: true })
    .order('starts_at', { ascending: false })

  if (error) throw error

  return data || []
}

export function invalidatePublicEventsCache() {
  sharedCacheGeneration += 1
  sharedCache = null
  sharedCacheExpiresAt = 0
  sharedCacheRequest = null
}

export async function getActivePublicEvents() {
  const nowMs = Date.now()

  if (
    sharedCache &&
    nowMs < sharedCacheExpiresAt
  ) {
    return filterActiveEvents(
      sharedCache,
      nowMs
    )
  }

  if (sharedCacheRequest) {
    const rows = await sharedCacheRequest

    return filterActiveEvents(
      rows,
      Date.now()
    )
  }

  const requestGeneration =
    sharedCacheGeneration

  const request = loadPublishedEvents(
    new Date(nowMs).toISOString()
  ).then((rows) => {
    if (
      requestGeneration ===
      sharedCacheGeneration
    ) {
      sharedCache = rows
      sharedCacheExpiresAt =
        Date.now() + CACHE_TTL_MS
    }

    return rows
  })

  sharedCacheRequest = request

  try {
    const rows = await request

    return filterActiveEvents(
      rows,
      Date.now()
    )
  } finally {
    if (
      sharedCacheRequest === request
    ) {
      sharedCacheRequest = null
    }
  }
}
