import { supabase } from '../config/supabase.js'

const CACHE_TTL_MS = 2 * 60 * 1000
const FEED_SCAN_LIMIT = 120

let cache = null
let cacheExpiresAt = 0
let cacheRequest = null
let cacheGeneration = 0

async function loadCandidates(snapshotAt) {
  const { data, error } = await supabase
    .from('reader_posts')
    .select('*')
    .is('deleted_at', null)
    .lte('publish_at', snapshotAt)
    .order('publish_at', {
      ascending: false,
    })
    .order('created_at', {
      ascending: false,
    })
    .limit(FEED_SCAN_LIMIT)

  if (error) {
    throw error
  }

  return data || []
}

export function invalidateReaderPostsFeedCandidateCache() {
  cacheGeneration += 1
  cache = null
  cacheExpiresAt = 0
  cacheRequest = null
}

export async function getReaderPostsFeedCandidates(
  snapshotAt = new Date().toISOString()
) {
  const now = Date.now()

  if (
    cache &&
    now < cacheExpiresAt
  ) {
    return cache
  }

  if (cacheRequest) {
    return cacheRequest
  }

  const requestGeneration =
    cacheGeneration

  const request =
    loadCandidates(snapshotAt)

  cacheRequest = request

  try {
    const value = await request

    if (
      requestGeneration ===
      cacheGeneration
    ) {
      cache = value
      cacheExpiresAt =
        Date.now() + CACHE_TTL_MS
    }

    return value
  } finally {
    if (cacheRequest === request) {
      cacheRequest = null
    }
  }
}
