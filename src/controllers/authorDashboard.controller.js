import { supabase } from '../config/supabase.js'

const PERIOD_DAYS = {
  today: 1,
  '7d': 7,
  '28d': 28,
  '30d': 30,
}

function safeNumber(value) {
  const number = Number(value || 0)
  return Number.isFinite(number) ? number : 0
}

function sumBy(items, key) {
  return (Array.isArray(items) ? items : []).reduce(
    (total, item) => total + safeNumber(item?.[key]),
    0
  )
}

function parsePeriod(value) {
  const period = String(value || '28d').trim().toLowerCase()
  return PERIOD_DAYS[period] ? period : '28d'
}

function toDateKey(value) {
  return new Date(value).toISOString().slice(0, 10)
}

function getDateRange(days) {
  const end = new Date()
  end.setUTCHours(0, 0, 0, 0)

  const start = new Date(end)
  start.setUTCDate(start.getUTCDate() - days + 1)

  return {
    start,
    end,
    startKey: toDateKey(start),
    endKey: toDateKey(end),
  }
}

function buildAnalyticsSeries(rows, start, days) {
  const rowMap = new Map(
    (rows || []).map((row) => [String(row.stat_date), row])
  )

  return Array.from({ length: days }, (_, index) => {
    const date = new Date(start)
    date.setUTCDate(start.getUTCDate() + index)
    const statDate = toDateKey(date)
    const row = rowMap.get(statDate) || {}

    return {
      stat_date: statDate,
      page_views: safeNumber(row.page_views),
      story_reads: safeNumber(row.story_reads),
      interactions: safeNumber(row.interactions),
      new_followers: safeNumber(row.new_followers),
      comments: safeNumber(row.comments),
    }
  })
}

async function fetchAllStories(authorPageId) {
  const rows = []
  const pageSize = 1000

  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from('stories')
      .select(
        'id, title, cover_url, total_episodes, total_views, total_likes, total_comments, created_at, updated_at'
      )
      .eq('author_id', authorPageId)
      .eq('status', 'published')
      .is('deleted_at', null)
      .order('updated_at', { ascending: false })
      .range(from, from + pageSize - 1)

    if (error) throw error

    const batch = data || []
    rows.push(...batch)

    if (batch.length < pageSize) break
  }

  return rows
}

async function fetchAllPosts(authorPageId) {
  const rows = []
  const pageSize = 1000

  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from('author_page_posts')
      .select(
        'id, content, image_urls, like_count, comment_count, echo_count, created_at, updated_at'
      )
      .eq('author_page_id', authorPageId)
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .range(from, from + pageSize - 1)

    if (error) throw error

    const batch = data || []
    rows.push(...batch)

    if (batch.length < pageSize) break
  }

  return rows
}

function chunkArray(items, size) {
  const chunks = []

  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size))
  }

  return chunks
}

async function fetchRecentComments(posts, limit = 3) {
  const postIds = posts.map((post) => post.id).filter(Boolean)

  if (!postIds.length) return []

  const postMap = new Map(posts.map((post) => [post.id, post]))
  const chunks = chunkArray(postIds, 100)

  const results = await Promise.all(
    chunks.map(async (ids) => {
      const { data, error } = await supabase
        .from('author_page_post_comments')
        .select(
          'id, post_id, user_id, text, created_at, user:users(id, name, username, avatar_url)'
        )
        .in('post_id', ids)
        .eq('is_hidden', false)
        .is('parent_id', null)
        .order('created_at', { ascending: false })
        .limit(limit)

      if (error) throw error
      return data || []
    })
  )

  return results
    .flat()
    .sort(
      (a, b) =>
        new Date(b.created_at || 0).getTime() -
        new Date(a.created_at || 0).getTime()
    )
    .slice(0, limit)
    .map((comment) => ({
      comment,
      post: postMap.get(comment.post_id) || null,
    }))
}

export async function getMyAuthorDashboard(req, res) {
  try {
    const userId = req.user?.user_id
    const period = parsePeriod(req.query.period)
    const days = PERIOD_DAYS[period]
    const range = getDateRange(days)

    if (!userId) {
      return res.status(401).json({ ok: false, message: 'Unauthorized' })
    }

    const { data: authorPage, error: pageError } = await supabase
      .from('author_pages')
      .select(
        'id, user_id, page_name, page_username, page_slug, bio, avatar_url, cover_url, profile_details, total_followers, status'
      )
      .eq('user_id', userId)
      .maybeSingle()

    if (pageError) throw pageError

    if (!authorPage) {
      return res.status(404).json({
        ok: false,
        message: 'Author page not found',
      })
    }

    const [
      stories,
      posts,
      analyticsResult,
      notificationsResult,
      unreadResult,
    ] = await Promise.all([
      fetchAllStories(authorPage.id),
      fetchAllPosts(authorPage.id),
      supabase
        .from('author_page_daily_analytics')
        .select(
          'stat_date, page_views, story_reads, interactions, new_followers, comments'
        )
        .eq('author_page_id', authorPage.id)
        .gte('stat_date', range.startKey)
        .lte('stat_date', range.endKey)
        .order('stat_date', { ascending: true }),
      supabase
        .from('author_page_notifications')
        .select(
          'id, type, title, message, target_url, metadata, is_read, created_at'
        )
        .eq('author_page_id', authorPage.id)
        .order('created_at', { ascending: false })
        .limit(5),
      supabase
        .from('author_page_notifications')
        .select('id', { count: 'exact', head: true })
        .eq('author_page_id', authorPage.id)
        .eq('is_read', false),
    ])

    if (analyticsResult.error) throw analyticsResult.error
    if (notificationsResult.error) throw notificationsResult.error
    if (unreadResult.error) throw unreadResult.error

    const recentComments = await fetchRecentComments(posts, 3)
    const series = buildAnalyticsSeries(
      analyticsResult.data || [],
      range.start,
      days
    )

    const postLikes = sumBy(posts, 'like_count')
    const postComments = sumBy(posts, 'comment_count')
    const postEchoes = sumBy(posts, 'echo_count')
    const storyViews = sumBy(stories, 'total_views')
    const storyLikes = sumBy(stories, 'total_likes')
    const storyComments = sumBy(stories, 'total_comments')
    const episodes = sumBy(stories, 'total_episodes')
    const topStories = [...stories]
  .sort(
    (a, b) =>
      safeNumber(b.total_views) - safeNumber(a.total_views) ||
      safeNumber(b.total_likes) - safeNumber(a.total_likes) ||
      safeNumber(b.total_comments) - safeNumber(a.total_comments)
  )
  .slice(0, 5)

const periodTotals = series.reduce(
      (totals, item) => ({
        page_views: totals.page_views + item.page_views,
        story_reads: totals.story_reads + item.story_reads,
        interactions: totals.interactions + item.interactions,
        new_followers: totals.new_followers + item.new_followers,
        comments: totals.comments + item.comments,
      }),
      {
        page_views: 0,
        story_reads: 0,
        interactions: 0,
        new_followers: 0,
        comments: 0,
      }
    )

    return res.status(200).json({
      ok: true,
      period,
      date_from: range.startKey,
      date_to: range.endKey,
      author_page: authorPage,
      overview: {
        posts: posts.length,
        stories: stories.length,
        followers: safeNumber(authorPage.total_followers),
        comments: postComments + storyComments,
        episodes,
        post_likes: postLikes,
        post_comments: postComments,
        post_echoes: postEchoes,
        story_views: storyViews,
        story_likes: storyLikes,
        story_comments: storyComments,
        lifetime_interactions:
          postLikes +
          postComments +
          postEchoes +
          storyLikes +
          storyComments,
      },
      period_totals: periodTotals,
      analytics: series,
      top_stories: topStories,
      latest_post: posts[0] || null,
      recent_comments: recentComments,
      notifications: notificationsResult.data || [],
      unread_updates: safeNumber(unreadResult.count),
    })
  } catch (error) {
    console.error('GET MY AUTHOR DASHBOARD ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load author dashboard',
      error: error.message,
    })
  }
}
