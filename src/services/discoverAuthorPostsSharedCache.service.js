import { supabase } from '../config/supabase.js'

const CACHE_TTL_MS = 5 * 60 * 1000
const CANDIDATE_LIMIT = 300
const POST_WINDOW_DAYS = 30
const MAX_SNAPSHOTS = 4

const snapshots = new Map()
const inflightRequests = new Map()
let latestSnapshotAt = ''
let cacheGeneration = 0

function normalizeSnapshotAt(value) {
  const date = new Date(value || Date.now())

  if (Number.isNaN(date.getTime())) {
    return new Date().toISOString()
  }

  return date.toISOString()
}

function getCutoffAt(snapshotAt) {
  return new Date(
    new Date(snapshotAt).getTime() -
      POST_WINDOW_DAYS * 24 * 60 * 60 * 1000
  ).toISOString()
}

function pruneSnapshots() {
  const now = Date.now()

  for (const [key, entry] of snapshots.entries()) {
    if (!entry || entry.expiresAt <= now) {
      snapshots.delete(key)
      if (latestSnapshotAt === key) {
        latestSnapshotAt = ''
      }
    }
  }

  if (snapshots.size <= MAX_SNAPSHOTS) return

  const ordered = [...snapshots.entries()].sort(
    (first, second) =>
      Number(first[1]?.createdAt || 0) -
      Number(second[1]?.createdAt || 0)
  )

  while (
    ordered.length &&
    snapshots.size > MAX_SNAPSHOTS
  ) {
    const [key] = ordered.shift()
    snapshots.delete(key)
    if (latestSnapshotAt === key) {
      latestSnapshotAt = ''
    }
  }
}

async function loadCatalog(snapshotAt) {
  const cutoffAt = getCutoffAt(snapshotAt)

  const { data: candidatePosts, error: postsError } =
    await supabase
      .from('author_page_posts')
      .select(
        'id, author_page_id, user_id, post_type, content, image_urls, status, like_count, comment_count, echo_count, created_at, updated_at'
      )
      .eq('status', 'active')
      .lte('created_at', snapshotAt)
      .gte('created_at', cutoffAt)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(CANDIDATE_LIMIT)

  if (postsError) throw postsError

  const posts = candidatePosts || []
  const authorPageIds = [
    ...new Set(
      posts
        .map((post) => post.author_page_id)
        .filter(Boolean)
    ),
  ]
  const postIds = [
    ...new Set(
      posts
        .map((post) => post.id)
        .filter(Boolean)
    ),
  ]

  const [pagesResult, hashtagsResult] = await Promise.all([
    authorPageIds.length
      ? supabase
          .from('author_pages')
          .select(
            'id, user_id, page_name, page_username, avatar_url, status, total_followers'
          )
          .in('id', authorPageIds)
          .eq('status', 'active')
      : Promise.resolve({ data: [], error: null }),
    postIds.length
      ? supabase
          .from('author_post_hashtags')
          .select('post_id, hashtag_id')
          .in('post_id', postIds)
      : Promise.resolve({ data: [], error: null }),
  ])

  if (pagesResult.error) throw pagesResult.error
  if (hashtagsResult.error) throw hashtagsResult.error

  return {
    snapshotAt,
    candidatePosts: posts,
    pages: pagesResult.data || [],
    postHashtags: hashtagsResult.data || [],
  }
}

async function readSnapshot(snapshotAt, makeLatest) {
  pruneSnapshots()

  const cached = snapshots.get(snapshotAt)

  if (cached && cached.expiresAt > Date.now()) {
    if (makeLatest) latestSnapshotAt = snapshotAt
    return cached.value
  }

  if (inflightRequests.has(snapshotAt)) {
    return inflightRequests.get(snapshotAt)
  }

  const requestGeneration = cacheGeneration
  const request = loadCatalog(snapshotAt)

  inflightRequests.set(snapshotAt, request)

  try {
    const value = await request

    if (requestGeneration === cacheGeneration) {
      snapshots.set(snapshotAt, {
        value,
        createdAt: Date.now(),
        expiresAt: Date.now() + CACHE_TTL_MS,
      })

      if (makeLatest) {
        latestSnapshotAt = snapshotAt
      }

      pruneSnapshots()
    }

    return value
  } finally {
    if (inflightRequests.get(snapshotAt) === request) {
      inflightRequests.delete(snapshotAt)
    }
  }
}

export function invalidateDiscoverAuthorPostsSharedCache() {
  cacheGeneration += 1
  latestSnapshotAt = ''
  snapshots.clear()
  inflightRequests.clear()
}

export async function getDiscoverAuthorPostsSharedCatalog({
  snapshotAt = '',
} = {}) {
  const requestedSnapshot = String(snapshotAt || '').trim()

  if (requestedSnapshot) {
    return readSnapshot(
      normalizeSnapshotAt(requestedSnapshot),
      false
    )
  }

  pruneSnapshots()

  if (latestSnapshotAt) {
    const cached = snapshots.get(latestSnapshotAt)

    if (cached && cached.expiresAt > Date.now()) {
      return cached.value
    }
  }

  const nextSnapshotAt = new Date().toISOString()
  return readSnapshot(nextSnapshotAt, true)
}
