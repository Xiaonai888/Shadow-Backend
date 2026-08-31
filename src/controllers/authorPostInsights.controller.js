import crypto from 'node:crypto'
import jwt from 'jsonwebtoken'
import { supabase } from '../config/supabase.js'

const VIEW_SOURCES = new Set([
  'feed',
  'suggested',
  'follower_feed',
  'author_page',
  'discover',
  'search',
  'share',
  'notification',
  'direct',
  'other',
])

function getRequestUserId(req) {
  try {
    const authHeader = String(req.headers.authorization || '')
    const token = authHeader.startsWith('Bearer ')
      ? authHeader.slice(7)
      : ''

    if (!token) return null

    const decoded = jwt.verify(token, process.env.JWT_SECRET)

    return decoded?.type === 'reader'
      ? decoded.user_id || null
      : null
  } catch {
    return null
  }
}

function normalizeSource(value) {
  const source = String(value || '')
    .trim()
    .toLowerCase()

  return VIEW_SOURCES.has(source)
    ? source
    : 'direct'
}

function getViewerKey(req, userId) {
  const forwardedFor = String(
    req.headers['x-forwarded-for'] || ''
  )
    .split(',')[0]
    .trim()
  const ip =
    forwardedFor ||
    req.ip ||
    req.socket?.remoteAddress ||
    ''
  const userAgent = String(
    req.headers['user-agent'] || ''
  )
  const raw = userId
    ? `user:${userId}`
    : `anon:${ip}|${userAgent}`

  return crypto
    .createHash('sha256')
    .update(raw)
    .digest('hex')
}

function buildViewTimeline(rows) {
  const buckets = new Map()

  for (const row of rows) {
    const date = new Date(row.viewed_at)

    if (Number.isNaN(date.getTime())) continue

    date.setUTCMinutes(0, 0, 0)
    const key = date.toISOString()
    buckets.set(key, Number(buckets.get(key) || 0) + 1)
  }

  let cumulative = 0

  return [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([time, views]) => {
      cumulative += views

      return {
        time,
        views,
        cumulative_views: cumulative,
      }
    })
}

function buildSourceBreakdown(rows) {
  const counts = new Map()

  for (const row of rows) {
    const source = normalizeSource(row.source)
    counts.set(source, Number(counts.get(source) || 0) + 1)
  }

  const total = rows.length

  return [...counts.entries()]
    .map(([source, views]) => ({
      source,
      views,
      percentage: total
        ? Number(((views / total) * 100).toFixed(1))
        : 0,
    }))
    .sort((a, b) => b.views - a.views)
}

function buildAudience(rows) {
  const viewers = new Map()

  for (const row of rows) {
    const key = String(row.viewer_key || '').trim()

    if (!key) continue

    const previous = viewers.get(key)

    viewers.set(key, {
      was_following: Boolean(
        row.was_following || previous?.was_following
      ),
    })
  }

  const uniqueViewers = [...viewers.values()]
  const followers = uniqueViewers.filter(
    (item) => item.was_following
  ).length
  const nonFollowers = Math.max(
    0,
    uniqueViewers.length - followers
  )
  const total = uniqueViewers.length

  return {
    viewers: total,
    followers,
    non_followers: nonFollowers,
    follower_percentage: total
      ? Number(((followers / total) * 100).toFixed(1))
      : 0,
    non_follower_percentage: total
      ? Number(((nonFollowers / total) * 100).toFixed(1))
      : 0,
  }
}

function buildReactionCounts(rows) {
  return (rows || []).reduce(
    (result, row) => {
      const type = String(row.reaction_type || 'love')
        .trim()
        .toLowerCase()

      result[type] = Number(result[type] || 0) + 1
      return result
    },
    {}
  )
}


const DEMOGRAPHICS_MIN_SAMPLE = 5
const TYPICAL_POST_LIMIT = 5
const TYPICAL_MIN_SAMPLE = 3
const TYPICAL_MAX_WINDOW_MS = 24 * 60 * 60 * 1000

function calculateAge(dateOfBirth) {
  const birthDate = new Date(dateOfBirth)
  const today = new Date()

  if (Number.isNaN(birthDate.getTime())) return null

  let age = today.getUTCFullYear() - birthDate.getUTCFullYear()
  const monthDiff =
    today.getUTCMonth() - birthDate.getUTCMonth()

  if (
    monthDiff < 0 ||
    (monthDiff === 0 &&
      today.getUTCDate() < birthDate.getUTCDate())
  ) {
    age -= 1
  }

  return age >= 0 ? age : null
}

function getAgeBucket(age) {
  if (!Number.isFinite(age) || age < 0) return null
  if (age < 18) return 'under_18'
  if (age <= 24) return '18_24'
  if (age <= 34) return '25_34'
  if (age <= 44) return '35_44'
  if (age <= 54) return '45_54'
  return '55_plus'
}

function buildCountBreakdown(values) {
  const counts = new Map()

  for (const value of values) {
    if (!value) continue
    counts.set(value, Number(counts.get(value) || 0) + 1)
  }

  const total = [...counts.values()].reduce(
    (sum, count) => sum + count,
    0
  )

  return [...counts.entries()]
    .map(([key, count]) => ({
      key,
      count,
      percentage: total
        ? Number(((count / total) * 100).toFixed(1))
        : 0,
    }))
    .sort((a, b) => b.count - a.count)
}

async function getViewerDemographics(views) {
  const viewerIds = [
    ...new Set(
      (views || [])
        .map((row) =>
          String(row.viewer_user_id || '').trim()
        )
        .filter(Boolean)
    ),
  ]

  if (viewerIds.length < DEMOGRAPHICS_MIN_SAMPLE) {
    return {
      available: false,
      registered_viewers: viewerIds.length,
      minimum_sample: DEMOGRAPHICS_MIN_SAMPLE,
    }
  }

  const { data: users, error } = await supabase
    .from('users')
    .select('id, date_of_birth, gender')
    .in('id', viewerIds)

  if (error) throw error

  const profiles = users || []
  const ageValues = profiles
    .map((user) => calculateAge(user.date_of_birth))
    .map(getAgeBucket)
    .filter(Boolean)

  const genderValues = profiles
    .map((user) => {
      const gender = String(user.gender || '')
        .trim()
        .toLowerCase()

      return ['female', 'male', 'custom'].includes(gender)
        ? gender
        : null
    })
    .filter(Boolean)

  const ageAvailable =
    ageValues.length >= DEMOGRAPHICS_MIN_SAMPLE
  const genderAvailable =
    genderValues.length >= DEMOGRAPHICS_MIN_SAMPLE

  return {
    available: ageAvailable || genderAvailable,
    registered_viewers: viewerIds.length,
    minimum_sample: DEMOGRAPHICS_MIN_SAMPLE,
    age: {
      available: ageAvailable,
      total: ageValues.length,
      groups: ageAvailable
        ? buildCountBreakdown(ageValues)
        : [],
    },
    gender: {
      available: genderAvailable,
      total: genderValues.length,
      groups: genderAvailable
        ? buildCountBreakdown(genderValues)
        : [],
    },
  }
}

function median(values) {
  const sorted = [...values]
    .map((value) => Number(value || 0))
    .sort((a, b) => a - b)

  if (!sorted.length) return 0

  const middle = Math.floor(sorted.length / 2)

  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2
}

async function getTypicalPerformance(post, currentViews) {
  if (!post?.author_page_id || !post?.created_at) {
    return {
      available: false,
      reason: 'missing_post_data',
    }
  }

  const createdAt = new Date(post.created_at)

  if (Number.isNaN(createdAt.getTime())) {
    return {
      available: false,
      reason: 'invalid_post_date',
    }
  }

  const {
    data: firstTrackedView,
    error: trackingStartError,
  } = await supabase
    .from('author_page_post_views')
    .select('viewed_at')
    .order('viewed_at', { ascending: true })
    .limit(1)
    .maybeSingle()

  if (trackingStartError) throw trackingStartError

  if (!firstTrackedView?.viewed_at) {
    return {
      available: false,
      reason: 'no_tracking_data',
    }
  }

  const trackingStartedAt = new Date(
    firstTrackedView.viewed_at
  )

  if (
    Number.isNaN(trackingStartedAt.getTime()) ||
    createdAt < trackingStartedAt
  ) {
    return {
      available: false,
      reason: 'post_predates_tracking',
    }
  }

  const { data: previousPosts, error: previousPostsError } =
    await supabase
      .from('author_page_posts')
      .select('id, created_at')
      .eq('author_page_id', post.author_page_id)
      .eq('status', 'active')
      .gte('created_at', firstTrackedView.viewed_at)
      .lt('created_at', post.created_at)
      .order('created_at', { ascending: false })
      .limit(TYPICAL_POST_LIMIT)

  if (previousPostsError) throw previousPostsError

  const baselinePosts = previousPosts || []

  if (baselinePosts.length < TYPICAL_MIN_SAMPLE) {
    return {
      available: false,
      reason: 'insufficient_previous_posts',
      sample_size: baselinePosts.length,
      minimum_sample: TYPICAL_MIN_SAMPLE,
    }
  }

  const elapsedMs = Math.max(
    60 * 1000,
    Date.now() - createdAt.getTime()
  )
  const windowMs = Math.min(
    TYPICAL_MAX_WINDOW_MS,
    elapsedMs
  )
  const currentWindowEnd =
    createdAt.getTime() + windowMs

  const currentWindowViews = (currentViews || []).filter(
    (row) => {
      const viewedAt = new Date(row.viewed_at).getTime()
      return (
        Number.isFinite(viewedAt) &&
        viewedAt <= currentWindowEnd
      )
    }
  ).length

  const baselineResults = await Promise.all(
    baselinePosts.map((baselinePost) => {
      const baselineCreatedAt = new Date(
        baselinePost.created_at
      )
      const baselineEnd = new Date(
        baselineCreatedAt.getTime() + windowMs
      ).toISOString()

      return supabase
        .from('author_page_post_views')
        .select('id', {
          count: 'exact',
          head: true,
        })
        .eq('post_id', String(baselinePost.id))
        .gte(
          'viewed_at',
          baselineCreatedAt.toISOString()
        )
        .lte('viewed_at', baselineEnd)
    })
  )

  for (const result of baselineResults) {
    if (result.error) throw result.error
  }

  const baselineCounts = baselineResults.map((result) =>
    Number(result.count || 0)
  )
  const typicalViews = median(baselineCounts)
  const minViews = Math.min(...baselineCounts)
  const maxViews = Math.max(...baselineCounts)

  let status = 'typical'

  if (typicalViews === 0) {
    status =
      currentWindowViews > 0
        ? 'above_typical'
        : 'typical'
  } else if (currentWindowViews > typicalViews * 1.1) {
    status = 'above_typical'
  } else if (currentWindowViews < typicalViews * 0.9) {
    status = 'below_typical'
  }

  return {
    available: true,
    basis: 'recorded_views_same_age_window',
    sample_size: baselineCounts.length,
    window_seconds: Math.round(windowMs / 1000),
    current_views: currentWindowViews,
    typical_views: typicalViews,
    typical_min: minViews,
    typical_max: maxViews,
    percent_vs_typical:
      typicalViews > 0
        ? Number(
            (
              ((currentWindowViews - typicalViews) /
                typicalViews) *
              100
            ).toFixed(1)
          )
        : null,
    status,
  }
}

export async function recordAuthorPostView(req, res, next) {
  try {
    const postId = String(req.params.postId || '').trim()

    if (postId) {
      const viewerUserId = getRequestUserId(req)
      const viewerKey = getViewerKey(req, viewerUserId)
      const source = normalizeSource(
        req.query.source ||
          req.headers['x-shadow-post-source'] ||
          'direct'
      )

      const { error } = await supabase.rpc(
        'record_author_post_view',
        {
          p_post_id: postId,
          p_viewer_user_id: viewerUserId
            ? String(viewerUserId)
            : null,
          p_viewer_key: viewerKey,
          p_source: source,
        }
      )

      if (error) {
        console.error('RECORD AUTHOR POST VIEW ERROR:', error)
      }
    }
  } catch (error) {
    console.error('RECORD AUTHOR POST VIEW ERROR:', error)
  }

  next()
}

export async function recordAuthorPostClick(req, res) {
  try {
    const postId = String(req.params.postId || '').trim()
    const targetUrl = String(req.body?.target_url || '').trim()

    if (!postId || !targetUrl || targetUrl.length > 2000) {
      return res.status(400).json({
        ok: false,
        message: 'Valid post ID and target URL are required',
      })
    }

    let parsedUrl

    try {
      parsedUrl = new URL(targetUrl)
    } catch {
      return res.status(400).json({
        ok: false,
        message: 'Invalid target URL',
      })
    }

    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      return res.status(400).json({
        ok: false,
        message: 'Invalid target URL',
      })
    }

    const clickerUserId = getRequestUserId(req)
    const clickerKey = getViewerKey(req, clickerUserId)

    const { data: post, error: postError } = await supabase
      .from('author_page_posts')
      .select('id, user_id, content')
      .eq('id', postId)
      .eq('status', 'active')
      .maybeSingle()

    if (postError) throw postError

    if (!post) {
      return res.status(404).json({
        ok: false,
        message: 'Post not found',
      })
    }

    if (!String(post.content || '').includes(targetUrl)) {
      return res.status(400).json({
        ok: false,
        message: 'Link does not belong to this post',
      })
    }

    if (
      clickerUserId &&
      String(post.user_id) === String(clickerUserId)
    ) {
      return res.status(200).json({
        ok: true,
        recorded: false,
      })
    }

    const recentSince = new Date(
      Date.now() - 2000
    ).toISOString()

    const { data: recent, error: recentError } = await supabase
      .from('author_page_post_clicks')
      .select('id')
      .eq('post_id', postId)
      .eq('clicker_key', clickerKey)
      .eq('target_url', targetUrl)
      .gte('clicked_at', recentSince)
      .limit(1)

    if (recentError) throw recentError

    if (recent?.length) {
      return res.status(200).json({
        ok: true,
        recorded: false,
      })
    }

    const { error: clickError } = await supabase
      .from('author_page_post_clicks')
      .insert({
        post_id: postId,
        clicker_user_id: clickerUserId
          ? String(clickerUserId)
          : null,
        clicker_key: clickerKey,
        target_url: targetUrl,
      })

    if (clickError) throw clickError

    return res.status(201).json({
      ok: true,
      recorded: true,
    })
  } catch (error) {
    console.error('RECORD AUTHOR POST CLICK ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to record post click',
    })
  }
}

export async function getMyAuthorPostInsights(req, res) {
  try {
    const userId = String(
      req.user?.user_id || req.user?.id || ''
    ).trim()
    const postId = String(req.params.postId || '').trim()

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    if (!postId) {
      return res.status(400).json({
        ok: false,
        message: 'Post ID is required',
      })
    }

    const { data: post, error: postError } = await supabase
      .from('author_page_posts')
      .select(
        'id, user_id, author_page_id, content, image_urls, created_at, status'
      )
      .eq('id', postId)
      .eq('status', 'active')
      .maybeSingle()

    if (postError) throw postError

    if (!post) {
      return res.status(404).json({
        ok: false,
        message: 'Post not found',
      })
    }

    let isOwner =
      String(post.user_id || '') === userId

    if (!isOwner && post.author_page_id) {
      const { data: authorPage, error: pageError } = await supabase
        .from('author_pages')
        .select('user_id')
        .eq('id', post.author_page_id)
        .maybeSingle()

      if (pageError) throw pageError

      isOwner =
        String(authorPage?.user_id || '') === userId
    }

    if (!isOwner) {
      return res.status(403).json({
        ok: false,
        message: 'You can only view insights for your own post',
      })
    }

    const [
      viewsResult,
      reactionsResult,
      commentsResult,
      echoesResult,
      savesResult,
      followsResult,
      clicksResult,
    ] = await Promise.all([
      supabase
        .from('author_page_post_views')
        .select(
          'viewer_key, viewer_user_id, source, was_following, viewed_at'
        )
        .eq('post_id', postId)
        .order('viewed_at', { ascending: true }),
      supabase
        .from('author_page_post_reactions')
        .select('reaction_type')
        .eq('post_id', postId),
      supabase
        .from('author_page_post_comments')
        .select('id', { count: 'exact', head: true })
        .eq('post_id', postId)
        .eq('is_hidden', false)
        .is('deleted_at', null),
      supabase
        .from('social_echoes_v2')
        .select('share_count')
        .eq('source_type', 'author_post')
        .eq('source_id', postId),
      supabase
        .from('saved_posts')
        .select('id', {
          count: 'exact',
          head: true,
        })
        .eq('source_type', 'author_post')
        .eq('source_id', postId),
      supabase
        .from('author_page_follows')
        .select('id', {
          count: 'exact',
          head: true,
        })
        .eq('author_page_id', post.author_page_id)
        .eq('source_post_id', postId),
      supabase
        .from('author_page_post_clicks')
        .select('id', {
          count: 'exact',
          head: true,
        })
        .eq('post_id', postId),
    ])

    if (viewsResult.error) throw viewsResult.error
    if (reactionsResult.error) throw reactionsResult.error
    if (commentsResult.error) throw commentsResult.error
    if (echoesResult.error) throw echoesResult.error
    if (savesResult.error) throw savesResult.error
    if (followsResult.error) throw followsResult.error
    if (clicksResult.error) throw clicksResult.error

    const views = viewsResult.data || []
    const reactions = reactionsResult.data || []
    const reactionCounts = buildReactionCounts(reactions)
    const reactionTotal = reactions.length
    const commentTotal = Number(commentsResult.count || 0)
    const shareTotal = (echoesResult.data || []).reduce(
      (total, item) =>
        total + Math.max(1, Number(item.share_count || 1)),
      0
    )

    const saveTotal = Number(savesResult.count || 0)
    const netFollowTotal = Number(followsResult.count || 0)
    const clickTotal = Number(clicksResult.count || 0)
    const audience = buildAudience(views)
    const [performance, demographics] =
      await Promise.all([
        getTypicalPerformance(post, views),
        getViewerDemographics(views),
      ])

    return res.status(200).json({
      ok: true,
      post: {
        id: post.id,
        content: String(post.content || '').slice(0, 300),
        image_urls: Array.isArray(post.image_urls)
          ? post.image_urls.slice(0, 5)
          : [],
        created_at: post.created_at,
      },
      overview: {
        views: views.length,
        viewers: audience.viewers,
        engagement:
          reactionTotal +
          commentTotal +
          shareTotal +
          saveTotal +
          clickTotal,
        net_follows: netFollowTotal,
      },
      engagement: {
        reactions: reactionTotal,
        reaction_by_type: reactionCounts,
        comments: commentTotal,
        shares: shareTotal,
        saves: saveTotal,
        clicks: clickTotal,
      },
      audience: {
        followers: audience.followers,
        non_followers: audience.non_followers,
        follower_percentage: audience.follower_percentage,
        non_follower_percentage:
          audience.non_follower_percentage,
      },
      traffic: buildSourceBreakdown(views),
      views_timeline: buildViewTimeline(views),
      performance,
      demographics,
    })
  } catch (error) {
    console.error('GET AUTHOR POST INSIGHTS ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load post insights',
      error: error.message,
    })
  }
}
