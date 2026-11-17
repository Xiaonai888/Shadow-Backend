import { supabase } from '../config/supabase.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const PAGE_SIZE = 150
const HIGHLIGHT_LIMIT = 100
const ENGAGEMENT_WINDOW_DAYS = 30

function normalizeId(value) {
  const id = String(value || '').trim().toLowerCase()
  return UUID.test(id) ? id : ''
}

function sourceQuery(database, senderUserId, authorPageId) {
  return authorPageId
    ? database.from('author_page_follows').select('follower_user_id').eq('author_page_id', authorPageId)
    : database.from('user_follows').select('follower_user_id').eq('following_user_id', senderUserId)
}

export async function getMassMentionFollowerPage({
  senderUserId,
  authorPageId = null,
  afterFollowerId = null,
  limit = PAGE_SIZE,
  database = supabase,
}) {
  const senderId = normalizeId(senderUserId)
  const pageId = authorPageId == null ? null : normalizeId(authorPageId)
  const cursor = afterFollowerId == null ? null : normalizeId(afterFollowerId)
  if (!senderId || (authorPageId != null && !pageId) || (afterFollowerId != null && !cursor)) {
    throw new TypeError('Invalid mass mention follower source')
  }
  const pageSize = Math.min(PAGE_SIZE, Math.max(1, Math.trunc(Number(limit) || PAGE_SIZE)))
  let query = sourceQuery(database, senderId, pageId)
    .order('follower_user_id', { ascending: true })
    .limit(pageSize)
  if (cursor) query = query.gt('follower_user_id', cursor)
  const { data, error } = await query
  if (error) throw error
  const ids = [...new Set((data || []).map((row) => normalizeId(row.follower_user_id)).filter(Boolean))]
  return {
    recipientUserIds: ids,
    nextCursor: ids.length ? ids[ids.length - 1] : cursor,
    hasMore: (data || []).length >= pageSize,
  }
}

async function recentEngagedFollowerIds({ senderUserId, authorPageId, database }) {
  const author = Boolean(authorPageId)
  const postTable = author ? 'author_page_posts' : 'reader_posts'
  const commentTable = author ? 'author_page_post_comments' : 'reader_post_comments'
  let postsQuery = database.from(postTable)
    .select('id')
    .eq(author ? 'author_page_id' : 'user_id', author ? authorPageId : senderUserId)
    .order('created_at', { ascending: false })
    .limit(40)
  postsQuery = author ? postsQuery.eq('status', 'active') : postsQuery.eq('visibility', 'public').is('deleted_at', null)
  const { data: posts, error: postError } = await postsQuery
  if (postError) throw postError
  const postIds = (posts || []).map((row) => normalizeId(row.id)).filter(Boolean)
  if (!postIds.length) return []

  const cutoff = new Date(Date.now() - ENGAGEMENT_WINDOW_DAYS * 86400000).toISOString()
  let commentsQuery = database.from(commentTable)
    .select('user_id,created_at')
    .in('post_id', postIds)
    .gte('created_at', cutoff)
    .eq('is_hidden', false)
    .order('created_at', { ascending: false })
    .limit(300)
  if (author) commentsQuery = commentsQuery.is('deleted_at', null)
  const { data: comments, error: commentError } = await commentsQuery
  if (commentError) throw commentError

  const scores = new Map()
  for (const row of comments || []) {
    const id = normalizeId(row.user_id)
    if (!id || id === senderUserId) continue
    const previous = scores.get(id) || { count: 0, latest: '' }
    scores.set(id, { count: previous.count + 1, latest: previous.latest || row.created_at || '' })
  }
  const ranked = [...scores.entries()]
    .sort((a, b) => b[1].count - a[1].count || b[1].latest.localeCompare(a[1].latest))
    .slice(0, 150)
    .map(([id]) => id)
  if (!ranked.length) return []

  const { data: follows, error: followsError } = await sourceQuery(database, senderUserId, authorPageId)
    .in('follower_user_id', ranked)
  if (followsError) throw followsError
  const valid = new Set((follows || []).map((row) => normalizeId(row.follower_user_id)))
  return ranked.filter((id) => valid.has(id)).slice(0, HIGHLIGHT_LIMIT)
}

export async function getMassMentionHighlightRecipients({
  senderUserId,
  authorPageId = null,
  database = supabase,
}) {
  const senderId = normalizeId(senderUserId)
  const pageId = authorPageId == null ? null : normalizeId(authorPageId)
  if (!senderId || (authorPageId != null && !pageId)) {
    throw new TypeError('Invalid highlight source')
  }
  const engaged = await recentEngagedFollowerIds({ senderUserId: senderId, authorPageId: pageId, database })
  if (engaged.length >= HIGHLIGHT_LIMIT) return engaged.slice(0, HIGHLIGHT_LIMIT)

  const { data: recent, error } = await sourceQuery(database, senderId, pageId)
    .order('created_at', { ascending: false })
    .limit(HIGHLIGHT_LIMIT + engaged.length)
  if (error) throw error
  const chosen = new Set(engaged)
  for (const row of recent || []) {
    const id = normalizeId(row.follower_user_id)
    if (id && id !== senderId) chosen.add(id)
    if (chosen.size >= HIGHLIGHT_LIMIT) break
  }
  return [...chosen].slice(0, HIGHLIGHT_LIMIT)
}
