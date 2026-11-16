import { supabase } from '../config/supabase.js'

const LOOKBACK_MS = 7 * 86400000
const CACHE_TTL_MS = 120000
const MAX_ROWS = 3000
const MAX_CACHED_READERS = 64
let cacheByDb = new WeakMap()

function databaseCache(db) {
  let cache = cacheByDb.get(db)
  if (!cache) {
    cache = new Map()
    cacheByDb.set(db, cache)
  }
  return cache
}

export function invalidateSmartAdRecentHistory(readerHash = '', { db = supabase } = {}) {
  if (!readerHash) {
    cacheByDb = new WeakMap()
    return
  }
  databaseCache(db).delete(String(readerHash))
}

export async function readSmartAdRecentHistory(readerHash, { db = supabase, now = Date.now() } = {}) {
  const reader = String(readerHash || '')
  if (!/^[0-9a-f]{64}$/.test(reader)) throw new TypeError('Invalid Smart Ad reader hash')
  const cache = databaseCache(db)
  const cached = cache.get(reader)
  if (cached && cached.expiresAt > now) return new Map(cached.records)

  const since = new Date(now - LOOKBACK_MS).toISOString()
  const { data, error } = await db.from('smart_ad_reader_exposure')
    .select('story_id,first_seen_at')
    .eq('reader_hash', reader)
    .gte('first_seen_at', since)
    .order('first_seen_at', { ascending: false })
    .limit(MAX_ROWS)
  if (error) throw error

  const records = new Map()
  for (const row of data || []) {
    const storyId = String(row?.story_id || '')
    const firstSeen = Date.parse(row?.first_seen_at || '')
    if (storyId && Number.isFinite(firstSeen) && !records.has(storyId)) {
      records.set(storyId, firstSeen)
    }
  }
  if (cache.size >= MAX_CACHED_READERS) cache.delete(cache.keys().next().value)
  cache.set(reader, { records, expiresAt: now + CACHE_TTL_MS })
  return new Map(records)
}
