import { supabase } from '../config/supabase.js'

const DEFAULT_LIMIT = 10
const MAX_LIMIT = 20
const CANDIDATE_LIMIT = 300
const POST_WINDOW_DAYS = 30

function clampLimit(value) {
  const number = Number(value || DEFAULT_LIMIT)

  if (!Number.isFinite(number)) return DEFAULT_LIMIT

  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(number)))
}

function normalizeImages(value) {
  if (!Array.isArray(value)) return []

  return value
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .slice(0, 5)
}

function encodeCursor(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

function decodeCursor(value) {
  if (!value) return null

  try {
    const decoded = JSON.parse(
      Buffer.from(String(value), 'base64url').toString('utf8')
    )

    const snapshotAt = new Date(decoded.snapshot_at)
    const offset = Number(decoded.offset || 0)

    if (
      Number.isNaN(snapshotAt.getTime()) ||
      !Number.isInteger(offset) ||
      offset < 0
    ) {
      return null
    }

    return {
      snapshot_at: snapshotAt.toISOString(),
      offset,
    }
  } catch {
    return null
  }
}

function compareNewest(first, second) {
  const timeDifference =
    new Date(second.created_at).getTime() -
    new Date(first.created_at).getTime()

  if (timeDifference !== 0) return timeDifference

  return String(second.id).localeCompare(String(first.id))
}

function buildFairOrder(posts, firstBatchLimit = DEFAULT_LIMIT) {
  const groups = new Map()

  for (const post of [...posts].sort(compareNewest)) {
    if (!groups.has(post.author_page_id)) {
      groups.set(post.author_page_id, [])
    }

    groups.get(post.author_page_id).push(post)
  }

  if (groups.size <= 1) {
    const orderedPosts = [...posts].sort(compareNewest)

    return {
      orderedPosts,
      firstBatchSize: Math.min(firstBatchLimit, orderedPosts.length),
    }
  }

  const authorGroups = [...groups.values()]
  const firstBatchCandidates = []
  const laterPosts = []

  for (let round = 0; round < 2; round += 1) {
    const roundItems = authorGroups
      .map((items) => items[round])
      .filter(Boolean)
      .sort(compareNewest)

    firstBatchCandidates.push(...roundItems)
  }

  let round = 2

  while (true) {
    const roundItems = authorGroups
      .map((items) => items[round])
      .filter(Boolean)
      .sort(compareNewest)

    if (!roundItems.length) break

    laterPosts.push(...roundItems)
    round += 1
  }

  return {
    orderedPosts: [...firstBatchCandidates, ...laterPosts],
    firstBatchSize: Math.min(
      firstBatchLimit,
      firstBatchCandidates.length
    ),
  }
}

function buildReactionData(rows, userId) {
  const summaryByPost = new Map()
  const myReactionByPost = new Map()

  for (const row of rows || []) {
    const postId = row.post_id
    const reactionType = String(row.reaction_type || '').trim().toLowerCase()

    if (!postId || !reactionType) continue

    if (!summaryByPost.has(postId)) {
      summaryByPost.set(postId, new Map())
    }

    const counts = summaryByPost.get(postId)
    counts.set(reactionType, Number(counts.get(reactionType) || 0) + 1)

    if (String(row.user_id) === String(userId)) {
      myReactionByPost.set(postId, reactionType)
    }
  }

  const normalizedSummary = new Map()

  for (const [postId, counts] of summaryByPost.entries()) {
    normalizedSummary.set(
      postId,
      [...counts.entries()]
        .map(([type, count]) => ({ type, count }))
        .sort((first, second) => {
          if (second.count !== first.count) {
            return second.count - first.count
          }

          return first.type.localeCompare(second.type)
        })
        .slice(0, 3)
    )
  }

  return {
    summaryByPost: normalizedSummary,
    myReactionByPost,
  }
}

export async function getFollowedAuthorPostsFeed(req, res) {
  try {
    const userId = req.user?.user_id
    const limit = clampLimit(req.query.limit)
    const cursor = decodeCursor(req.query.cursor)
    const snapshotAt = cursor?.snapshot_at || new Date().toISOString()
    const offset = cursor?.offset || 0
    const cutoffAt = new Date(
      new Date(snapshotAt).getTime() -
        POST_WINDOW_DAYS * 24 * 60 * 60 * 1000
    ).toISOString()

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    const { data: followRows, error: followError } = await supabase
      .from('author_page_follows')
      .select('author_page_id')
      .eq('follower_user_id', userId)

    if (followError) throw followError

    const followedPageIds = [
      ...new Set(
        (followRows || [])
          .map((item) => item.author_page_id)
          .filter(Boolean)
      ),
    ]

    if (!followedPageIds.length) {
      return res.status(200).json({
        ok: true,
        posts: [],
        limit,
        has_more: false,
        next_cursor: null,
        snapshot_at: snapshotAt,
      })
    }

    const { data: authorPages, error: authorPagesError } = await supabase
      .from('author_pages')
      .select(
        'id, user_id, page_name, page_username, avatar_url, status'
      )
      .in('id', followedPageIds)
      .eq('status', 'active')

    if (authorPagesError) throw authorPagesError

    const authorById = new Map(
      (authorPages || []).map((authorPage) => [
        authorPage.id,
        authorPage,
      ])
    )
    const activeAuthorIds = [...authorById.keys()]

    if (!activeAuthorIds.length) {
      return res.status(200).json({
        ok: true,
        posts: [],
        limit,
        has_more: false,
        next_cursor: null,
        snapshot_at: snapshotAt,
      })
    }

    const { data: postRows, error: postsError } = await supabase
      .from('author_page_posts')
      .select(
        'id, author_page_id, user_id, post_type, content, image_urls, status, like_count, comment_count, echo_count, created_at, updated_at'
      )
      .in('author_page_id', activeAuthorIds)
      .eq('status', 'active')
      .lte('created_at', snapshotAt)
      .gte('created_at', cutoffAt)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(CANDIDATE_LIMIT)

    if (postsError) throw postsError

    const { orderedPosts, firstBatchSize } = buildFairOrder(
  postRows || [],
  limit
)

const pageSize = offset === 0 ? firstBatchSize : limit

const selectedPosts = orderedPosts.slice(
  offset,
  offset + pageSize
)
    const selectedPostIds = selectedPosts.map((post) => post.id)

    let reactionRows = []

    if (selectedPostIds.length) {
      const { data, error } = await supabase
        .from('author_page_post_reactions')
        .select('post_id, user_id, reaction_type')
        .in('post_id', selectedPostIds)

      if (error) throw error

      reactionRows = data || []
    }

    const { summaryByPost, myReactionByPost } =
      buildReactionData(reactionRows, userId)

    const posts = selectedPosts.map((post) => ({
      id: post.id,
      author_page_id: post.author_page_id,
      post_type: post.post_type || 'article',
      content: post.content || '',
      image_urls: normalizeImages(post.image_urls),
      like_count: Number(post.like_count || 0),
      comment_count: Number(post.comment_count || 0),
      echo_count: Number(post.echo_count || 0),
      reaction_summary: summaryByPost.get(post.id) || [],
      my_reaction: myReactionByPost.get(post.id) || null,
      created_at: post.created_at,
      updated_at: post.updated_at,
      author_page: authorById.get(post.author_page_id) || null,
    }))

    const nextOffset = offset + posts.length
    const hasMore = nextOffset < orderedPosts.length

    return res.status(200).json({
      ok: true,
      posts,
      limit,
      has_more: hasMore,
      next_cursor: hasMore
        ? encodeCursor({
            snapshot_at: snapshotAt,
            offset: nextOffset,
          })
        : null,
      snapshot_at: snapshotAt,
    })
  } catch (error) {
    console.error('GET FOLLOWED AUTHOR POSTS FEED ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load followed author posts',
      error: error.message,
    })
  }
}
