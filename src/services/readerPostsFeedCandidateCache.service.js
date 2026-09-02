import { supabase } from '../config/supabase.js'

const CACHE_TTL_MS = 5 * 60 * 1000
const FEED_SCAN_LIMIT = 120

let cache = null
let cacheExpiresAt = 0
let cacheRequest = null
let cacheGeneration = 0

function uniqueStrings(values) {
  return [
    ...new Set(
      (values || [])
        .map((value) => String(value || '').trim())
        .filter(Boolean)
    ),
  ]
}

function buildUserMap(rows) {
  return new Map(
    (rows || [])
      .filter((user) => user?.is_active !== false)
      .map((user) => [String(user.id), user])
  )
}

function buildEchoCounts(v2Rows, legacyRows) {
  const preferred = new Map()

  for (const row of legacyRows || []) {
    const key = `${String(row.user_id || '')}:${String(
      row.source_id || ''
    )}`
    preferred.set(key, row)
  }

  for (const row of v2Rows || []) {
    const key = `${String(row.user_id || '')}:${String(
      row.source_id || ''
    )}`
    preferred.set(key, row)
  }

  const counts = new Map()

  for (const row of preferred.values()) {
    const id = String(row.source_id || '')
    counts.set(
      id,
      Number(counts.get(id) || 0) +
        Math.max(1, Number(row.share_count || 1))
    )
  }

  return counts
}

async function loadCandidates(snapshotAt) {
  const { data: posts, error: postsError } = await supabase
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

  if (postsError) {
    throw postsError
  }

  const rows = posts || []
  const ownerIds = uniqueStrings(
    rows.map((post) => post?.user_id)
  )
  const postIds = uniqueStrings(
    rows.map((post) => post?.id)
  )

  const [usersResult, v2EchoResult, legacyEchoResult] =
    await Promise.all([
      ownerIds.length
        ? supabase
            .from('users')
            .select('id, name, username, avatar_url, is_active')
            .in('id', ownerIds)
        : Promise.resolve({ data: [], error: null }),
      postIds.length
        ? supabase
            .from('social_echoes_v2')
            .select('user_id, source_id, share_count')
            .eq('source_type', 'reader_post')
            .in('source_id', postIds)
        : Promise.resolve({ data: [], error: null }),
      postIds.length
        ? supabase
            .from('social_echoes')
            .select('user_id, source_id, share_count')
            .eq('source_type', 'reader_post')
            .in('source_id', postIds)
        : Promise.resolve({ data: [], error: null }),
    ])

  if (usersResult.error) {
    throw usersResult.error
  }

  if (v2EchoResult.error) {
    throw v2EchoResult.error
  }

  if (legacyEchoResult.error) {
    throw legacyEchoResult.error
  }

  const userMap = buildUserMap(usersResult.data)
  const echoCounts = buildEchoCounts(
    v2EchoResult.data,
    legacyEchoResult.data
  )

  return rows.map((post) => ({
    ...post,
    __feed_shared_state_loaded: true,
    __feed_user:
      userMap.get(String(post.user_id || '')) || null,
    __feed_echo_count: Number(
      echoCounts.get(String(post.id || '')) || 0
    ),
  }))
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

  if (cache && now < cacheExpiresAt) {
    return cache
  }

  if (cacheRequest) {
    return cacheRequest
  }

  const requestGeneration = cacheGeneration
  const request = loadCandidates(snapshotAt)

  cacheRequest = request

  try {
    const value = await request

    if (requestGeneration === cacheGeneration) {
      cache = value
      cacheExpiresAt = Date.now() + CACHE_TTL_MS
    }

    return value
  } finally {
    if (cacheRequest === request) {
      cacheRequest = null
    }
  }
}
