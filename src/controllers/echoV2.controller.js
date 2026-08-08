import { supabase } from '../config/supabase.js'
import { incrementAuthorPageAnalytics } from '../services/authorAnalytics.service.js'
import { createAuthorStoryNotificationSafely } from '../services/authorStoryNotifications.service.js'

const SOURCE_TYPES = new Set([
  'story',
  'episode',
  'reader_post',
  'author_post',
  'shadow_mall_promotion',
])

const DESTINATIONS = new Set([
  'feed',
  'shadow',
  'reader',
  'circle',
])

const AUDIENCES = new Set([
  'public',
  'followers',
  'close-readers',
  'only-me',
])

function getUserId(req) {
  return String(
    req.user?.user_id ||
      req.user?.id ||
      ''
  ).trim()
}

function cleanText(value, maxLength = 280) {
  return String(value || '')
    .trim()
    .slice(0, maxLength)
}

function normalizeChoice(
  value,
  allowed,
  fallback
) {
  const normalized = String(
    value || fallback
  )
    .trim()
    .toLowerCase()

  return allowed.has(normalized)
    ? normalized
    : fallback
}

function normalizeSourceType(value) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()

  return SOURCE_TYPES.has(normalized)
    ? normalized
    : ''
}

function normalizeReaderIds(value) {
  if (!Array.isArray(value)) return []

  return [
    ...new Set(
      value
        .map((item) =>
          String(item || '').trim()
        )
        .filter(Boolean)
    ),
  ].slice(0, 50)
}

function normalizeUser(
  user,
  fallbackId = ''
) {
  const row = Array.isArray(user)
    ? user[0]
    : user

  return {
    id: row?.id || fallbackId,
    name:
      row?.name ||
      row?.username ||
      'Reader',
    username: row?.username || '',
    avatar_url: row?.avatar_url || '',
  }
}

async function readUser(userId) {
  const { data, error } = await supabase
    .from('users')
    .select(
      'id, name, username, avatar_url, is_active'
    )
    .eq('id', userId)
    .maybeSingle()

  if (error) throw error

  if (
    !data ||
    data.is_active === false
  ) {
    return null
  }

  return data
}

async function readActiveReaderIds(ids) {
  if (!ids.length) return []

  const { data, error } = await supabase
    .from('users')
    .select('id')
    .in('id', ids)
    .eq('is_active', true)

  if (error) throw error

  return (data || []).map((row) =>
    String(row.id)
  )
}

async function viewerFollows(
  followerId,
  followingId
) {
  if (!followerId || !followingId) {
    return false
  }

  const { data, error } = await supabase
    .from('user_follows')
    .select('follower_user_id')
    .eq('follower_user_id', followerId)
    .eq('following_user_id', followingId)
    .maybeSingle()

  if (error) throw error

  return Boolean(data)
}

async function canViewReaderPost(
  post,
  viewerId
) {
  if (!post) return false

  const ownerId = String(
    post.user_id || ''
  )
  const currentViewerId = String(
    viewerId || ''
  )

  if (
    currentViewerId &&
    ownerId === currentViewerId
  ) {
    return true
  }

  if (
    post.publish_at &&
    new Date(post.publish_at).getTime() >
      Date.now()
  ) {
    return false
  }

  const visibility = String(
    post.visibility || 'public'
  )
    .trim()
    .toLowerCase()

  if (visibility === 'public') {
    return true
  }

  if (
    !currentViewerId ||
    visibility === 'only_me' ||
    visibility === 'private'
  ) {
    return false
  }

  const viewerFollowsOwner =
    await viewerFollows(
      currentViewerId,
      ownerId
    )

  if (visibility === 'followers') {
    return viewerFollowsOwner
  }

  const ownerFollowsViewer =
    await viewerFollows(
      ownerId,
      currentViewerId
    )

  if (visibility === 'friends') {
    return (
      viewerFollowsOwner &&
      ownerFollowsViewer
    )
  }

  if (
    visibility ===
    'friends_and_followers'
  ) {
    return (
      viewerFollowsOwner ||
      ownerFollowsViewer
    )
  }

  return false
}

async function readSource(
  sourceType,
  sourceId,
  viewerId
) {
  if (sourceType === 'story') {
    const { data: story, error } =
      await supabase
        .from('stories')
        .select(
          'id, author_id, user_id, title, cover_url, landscape_thumbnail_url, main_genre, status, deleted_at'
        )
        .eq('id', sourceId)
        .is('deleted_at', null)
        .maybeSingle()

    if (error) throw error

    if (
      !story ||
      String(story.status || '')
        .toLowerCase() !== 'published'
    ) {
      return null
    }

    let authorPage = null

    if (story.author_id) {
      const { data, error: authorError } =
        await supabase
          .from('author_pages')
          .select(
            'id, user_id, page_name, page_username, avatar_url'
          )
          .eq('id', story.author_id)
          .maybeSingle()

      if (authorError) throw authorError
      authorPage = data || null
    }

    const imageUrl =
      story.landscape_thumbnail_url ||
      story.cover_url ||
      ''

    return {
      type: 'story',
      id: String(story.id),
      name: story.title || 'Story',
      content: '',
      image_url: imageUrl,
      image_urls: imageUrl
        ? [imageUrl]
        : [],
      label: 'story',
      url: `/story/${story.id}`,
      owner: authorPage,
      story: {
        id: story.id,
        title: story.title || '',
        cover_url:
          story.cover_url || '',
        landscape_thumbnail_url:
          story.landscape_thumbnail_url ||
          '',
        main_genre:
          story.main_genre || '',
      },
    }
  }

  if (sourceType === 'episode') {
    const { data: episode, error } =
      await supabase
        .from('episodes')
        .select(
          'id, story_id, title, episode_number, cover_url, status, deleted_at'
        )
        .eq('id', sourceId)
        .is('deleted_at', null)
        .maybeSingle()

    if (error) throw error

    if (
      !episode ||
      String(episode.status || '')
        .toLowerCase() !== 'published'
    ) {
      return null
    }

    const { data: story, error: storyError } =
      await supabase
        .from('stories')
        .select(
          'id, author_id, user_id, title, cover_url, landscape_thumbnail_url, main_genre, status, deleted_at'
        )
        .eq('id', episode.story_id)
        .is('deleted_at', null)
        .maybeSingle()

    if (storyError) throw storyError

    if (
      !story ||
      String(story.status || '')
        .toLowerCase() !== 'published'
    ) {
      return null
    }

    let authorPage = null

    if (story.author_id) {
      const { data, error: authorError } =
        await supabase
          .from('author_pages')
          .select(
            'id, user_id, page_name, page_username, avatar_url'
          )
          .eq('id', story.author_id)
          .maybeSingle()

      if (authorError) throw authorError
      authorPage = data || null
    }

    const imageUrl =
      story.landscape_thumbnail_url ||
      story.cover_url ||
      episode.cover_url ||
      ''
    const episodeTitle =
      episode.title ||
      `Episode ${Number(
        episode.episode_number || 0
      )}`

    return {
      type: 'episode',
      id: String(episode.id),
      name: story.title || 'Story',
      content: episodeTitle,
      image_url: imageUrl,
      image_urls: imageUrl
        ? [imageUrl]
        : [],
      label: 'episode',
      url:
        `/story/${story.id}/episode/${episode.id}`,
      owner: authorPage,
      story: {
        id: story.id,
        title: story.title || '',
        cover_url:
          story.cover_url || '',
        landscape_thumbnail_url:
          story.landscape_thumbnail_url ||
          '',
        main_genre:
          story.main_genre || '',
      },
      episode: {
        id: episode.id,
        story_id: episode.story_id,
        title: episodeTitle,
        episode_number: Number(
          episode.episode_number || 0
        ),
        cover_url:
          episode.cover_url || '',
      },
    }
  }

  if (sourceType === 'reader_post') {
    const { data: post, error } =
      await supabase
        .from('reader_posts')
        .select(
          'id, user_id, content, image_urls, visibility, publish_at, created_at, deleted_at'
        )
        .eq('id', sourceId)
        .is('deleted_at', null)
        .maybeSingle()

    if (error) throw error

    if (
      !post ||
      !(await canViewReaderPost(
        post,
        viewerId
      ))
    ) {
      return null
    }

    const user = await readUser(
      post.user_id
    )

    if (!user) return null

    const images = Array.isArray(
      post.image_urls
    )
      ? post.image_urls.filter(Boolean)
      : []
    const username = String(
      user.username || ''
    ).trim()

    return {
      type: 'reader_post',
      id: String(post.id),
      name:
        user.name ||
        username ||
        'Reader Post',
      content: post.content || '',
      image_url: images[0] || '',
      image_urls: images,
      label: 'reader post',
      url: username
        ? `/profile?username=${encodeURIComponent(
            username
          )}#reader-post-${post.id}`
        : `/profile#reader-post-${post.id}`,
      created_at:
        post.created_at ||
        post.publish_at ||
        null,
      owner: normalizeUser(
        user,
        post.user_id
      ),
    }
  }

  if (sourceType === 'author_post') {
    const { data: post, error } =
      await supabase
        .from('author_page_posts')
        .select(
          'id, author_page_id, user_id, content, image_urls, status, created_at, author_page:author_pages(id, user_id, page_name, page_username, avatar_url)'
        )
        .eq('id', sourceId)
        .eq('status', 'active')
        .maybeSingle()

    if (error) throw error
    if (!post) return null

    const authorPage = Array.isArray(
      post.author_page
    )
      ? post.author_page[0]
      : post.author_page
    const images = Array.isArray(
      post.image_urls
    )
      ? post.image_urls.filter(Boolean)
      : []

    return {
      type: 'author_post',
      id: String(post.id),
      name:
        authorPage?.page_name ||
        'Author Post',
      content: post.content || '',
      image_url: images[0] || '',
      image_urls: images,
      label: 'author post',
      url:
        authorPage?.page_username
          ? `/author/page/${encodeURIComponent(
              authorPage.page_username
            )}?post=${encodeURIComponent(
              post.id
            )}`
          : '/',
      created_at:
        post.created_at || null,
      owner: authorPage || null,
    }
  }

  if (
    sourceType ===
    'shadow_mall_promotion'
  ) {
    const numericId = Number(sourceId)

    if (
      !Number.isInteger(numericId) ||
      numericId <= 0
    ) {
      return null
    }

    const { data: promotion, error } =
      await supabase
        .from('shadow_mall_ads')
        .select(
          'id, sponsor, title, description, button_text, link_url, promotion_type, story_id, profile_image_url, image_url, is_active, created_at, updated_at'
        )
        .eq('id', numericId)
        .eq('is_active', true)
        .maybeSingle()

    if (error) throw error
    if (!promotion) return null

    const imageUrl =
      promotion.image_url ||
      promotion.profile_image_url ||
      ''

    return {
      type:
        'shadow_mall_promotion',
      id: String(promotion.id),
      name:
        promotion.sponsor ||
        'Shadow Mall',
      content:
        promotion.description ||
        promotion.title ||
        '',
      image_url: imageUrl,
      image_urls: imageUrl
        ? [imageUrl]
        : [],
      label: 'Shadow Mall promotion',
      url:
        promotion.link_url ||
        (promotion.story_id
          ? `/story/${promotion.story_id}`
          : '/shop'),
      created_at:
        promotion.created_at || null,
      owner: {
        id: null,
        name:
          promotion.sponsor ||
          'Shadow Mall',
        username: '',
        avatar_url:
          promotion.profile_image_url ||
          '',
      },
      promotion: {
        id: promotion.id,
        sponsor:
          promotion.sponsor ||
          'Shadow Mall',
        title: promotion.title || '',
        description:
          promotion.description || '',
        button_text:
          promotion.button_text ||
          'Shop now',
        link_url:
          promotion.link_url || '',
        promotion_type:
          promotion.promotion_type ||
          'link',
        story_id:
          promotion.story_id || null,
        profile_image_url:
          promotion.profile_image_url ||
          '',
        image_url:
          promotion.image_url || '',
      },
    }
  }

  return null
}

async function canViewEcho(
  echo,
  viewerId
) {
  const ownerId = String(
    echo.user_id || ''
  )
  const currentViewerId = String(
    viewerId || ''
  )

  if (
    currentViewerId &&
    currentViewerId === ownerId
  ) {
    return true
  }

  const selectedReaderIds =
    Array.isArray(
      echo.selected_reader_ids
    )
      ? echo.selected_reader_ids.map(
          (id) => String(id)
        )
      : []

  if (
    echo.destination === 'reader' ||
    echo.destination === 'circle'
  ) {
    return (
      Boolean(currentViewerId) &&
      selectedReaderIds.includes(
        currentViewerId
      )
    )
  }

  if (echo.audience === 'public') {
    return true
  }

  if (
    !currentViewerId ||
    echo.audience === 'only-me'
  ) {
    return false
  }

  if (
    echo.audience === 'close-readers'
  ) {
    return selectedReaderIds.includes(
      currentViewerId
    )
  }

  if (echo.audience === 'followers') {
    return viewerFollows(
      currentViewerId,
      ownerId
    )
  }

  return false
}

async function hydrateEcho(
  echo,
  viewerId,
  sourceOverride = null
) {
  if (!echo) return null

  if (
    !(await canViewEcho(
      echo,
      viewerId
    ))
  ) {
    return null
  }

  const [user, source] =
    await Promise.all([
      readUser(echo.user_id),
      sourceOverride
        ? Promise.resolve(sourceOverride)
        : readSource(
            echo.source_type,
            echo.source_id,
            viewerId
          ),
    ])

  if (!user || !source) {
    return null
  }

  return {
    id: echo.id,
    user_id: echo.user_id,
    source_type:
      echo.source_type,
    source_id: echo.source_id,
    echo_text: echo.echo_text || '',
    destination:
      echo.destination || 'feed',
    audience:
      echo.audience || 'public',
    selected_reader_ids:
      Array.isArray(
        echo.selected_reader_ids
      )
        ? echo.selected_reader_ids
        : [],
    share_count: Number(
      echo.share_count || 1
    ),
    created_at: echo.created_at,
    updated_at: echo.updated_at,
    user: normalizeUser(
      user,
      echo.user_id
    ),
    source,
  }
}

async function readSourceEchoCount(
  sourceType,
  sourceId
) {
  const { data, error } = await supabase
    .from('social_echoes_v2')
    .select('share_count')
    .eq('source_type', sourceType)
    .eq('source_id', sourceId)

  if (error) throw error

  return (data || []).reduce(
    (total, item) =>
      total +
      Math.max(
        1,
        Number(item.share_count || 1)
      ),
    0
  )
}

async function readLinkedReaderPostId(
  echoId,
  userId
) {
  const { data, error } = await supabase
    .from('social_echo_reader_posts_v2')
    .select('reader_post_id')
    .eq('echo_id', echoId)
    .eq('user_id', userId)
    .maybeSingle()

  if (error) throw error

  return String(
    data?.reader_post_id || ''
  ).trim()
}

async function setLinkedReaderPostDeleted(
  readerPostId,
  userId,
  deleted
) {
  if (!readerPostId) return false

  const updatedAt =
    new Date().toISOString()

  let query = supabase
    .from('reader_posts')
    .update({
      deleted_at: deleted
        ? updatedAt
        : null,
      updated_at: updatedAt,
    })
    .eq('id', readerPostId)
    .eq('user_id', userId)

  if (deleted) {
    query = query.is(
      'deleted_at',
      null
    )
  }

  const { data, error } = await query
    .select('id')
    .maybeSingle()

  if (error) throw error

  return Boolean(data?.id)
}

async function reserveShare({
  userId,
  sourceType,
  sourceId,
}) {
  const { data, error } = await supabase.rpc(
    'reserve_social_echo_share_v2',
    {
      p_user_id: userId,
      p_source_type: sourceType,
      p_source_id: sourceId,
    }
  )

  if (error) throw error

  const result =
    data &&
    typeof data === 'object'
      ? data
      : {}

  if (!result.allowed) {
    const limitError = new Error(
      result.message ||
        'Echo limit reached.'
    )

    limitError.statusCode = 429
    limitError.reason =
      result.reason || 'echo_limit'
    limitError.nextShareAt =
      result.next_share_at || null
    limitError.retryAfterSeconds =
      Math.max(
        0,
        Number(
          result.retry_after_seconds ||
            0
        )
      )

    throw limitError
  }

  return {
    eventId: String(
      result.event_id || ''
    ),
    sameSourceRemaining:
      Math.max(
        0,
        Number(
          result.same_post_remaining ||
            0
        )
      ),
    dailyRemaining: Math.max(
      0,
      Number(
        result.daily_remaining || 0
      )
    ),
  }
}

async function releaseShare(eventId) {
  if (!eventId) return

  const { error } = await supabase
    .from('social_echo_events_v2')
    .delete()
    .eq('id', eventId)

  if (error) {
    console.error(
      'RELEASE ECHO V2 LIMIT ERROR:',
      error
    )
  }
}

function sendError(
  res,
  error,
  fallback
) {
  const statusCode =
    Number(error.statusCode) || 500

  if (error.retryAfterSeconds > 0) {
    res.set(
      'Retry-After',
      String(
        error.retryAfterSeconds
      )
    )
  }

  return res.status(statusCode).json({
    ok: false,
    message:
      error.message || fallback,
    reason:
      error.reason || undefined,
    next_share_at:
      error.nextShareAt || undefined,
    retry_after_seconds:
      error.retryAfterSeconds ||
      undefined,
  })
}

export async function getEchoV2Health(
  req,
  res
) {
  try {
    const { error } = await supabase
      .from('social_echoes_v2')
      .select('id', {
        count: 'exact',
        head: true,
      })

    if (error) throw error

    return res.status(200).json({
      ok: true,
      version: 'v2',
    })
  } catch (error) {
    return sendError(
      res,
      error,
      'Echo V2 is not ready'
    )
  }
}

export async function createEchoV2(
  req,
  res
) {
  let reservedEventId = ''
  let saved = false

  try {
    const userId = getUserId(req)
    const sourceType =
      normalizeSourceType(
        req.body?.source_type
      )
    const sourceId = cleanText(
      req.body?.source_id,
      120
    )

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Login is required',
      })
    }

    if (!sourceType || !sourceId) {
      return res.status(400).json({
        ok: false,
        message:
          'Valid source_type and source_id are required',
      })
    }

    const source = await readSource(
      sourceType,
      sourceId,
      userId
    )

    if (!source) {
      return res.status(404).json({
        ok: false,
        message:
          'The shared content was not found or cannot be viewed',
      })
    }

    const echoText = cleanText(
      req.body?.echo_text,
      280
    )
    const destination =
      normalizeChoice(
        req.body?.destination,
        DESTINATIONS,
        'feed'
      )
    const audience = normalizeChoice(
      req.body?.audience,
      AUDIENCES,
      'public'
    )
    const requestedReaders =
      normalizeReaderIds(
        req.body?.selected_reader_ids
      ).filter(
        (id) => id !== userId
      )
    const selectedReaderIds =
      await readActiveReaderIds(
        requestedReaders
      )

    if (
      (destination === 'reader' ||
        destination === 'circle' ||
        audience ===
          'close-readers') &&
      !selectedReaderIds.length
    ) {
      return res.status(400).json({
        ok: false,
        message:
          'Select at least one reader for this echo',
      })
    }

    const reservation =
      await reserveShare({
        userId,
        sourceType,
        sourceId,
      })

    reservedEventId =
      reservation.eventId

    const now = new Date().toISOString()

    const {
      data: existing,
      error: existingError,
    } = await supabase
      .from('social_echoes_v2')
      .select(
        'id, share_count, created_at'
      )
      .eq('user_id', userId)
      .eq(
        'source_type',
        sourceType
      )
      .eq('source_id', sourceId)
      .maybeSingle()

    if (existingError) {
      throw existingError
    }

    let data = null
    let created = false

    if (existing) {
      const {
        data: updated,
        error,
      } = await supabase
        .from('social_echoes_v2')
        .update({
          echo_text: echoText,
          destination,
          audience,
          selected_reader_ids:
            selectedReaderIds,
          share_count:
            Math.max(
              1,
              Number(
                existing.share_count ||
                  1
              )
            ) + 1,
          updated_at: now,
        })
        .eq('id', existing.id)
        .eq('user_id', userId)
        .select('*')
        .single()

      if (error) throw error
      data = updated
    } else {
      const {
        data: inserted,
        error,
      } = await supabase
        .from('social_echoes_v2')
        .insert({
          user_id: userId,
          source_type: sourceType,
          source_id: sourceId,
          echo_text: echoText,
          destination,
          audience,
          selected_reader_ids:
            selectedReaderIds,
          share_count: 1,
          created_at: now,
          updated_at: now,
        })
        .select('*')
        .single()

      if (error) throw error
      data = inserted
      created = true
    }

    saved = true

    const authorPageId = String(
  source?.owner?.id || ''
)
const ownerUserId = String(
  source?.owner?.user_id || ''
)

const shouldNotify =
  created &&
  Boolean(authorPageId) &&
  Boolean(ownerUserId) &&
  ownerUserId !== String(userId) &&
  audience !== 'only-me' &&
  (sourceType === 'story' ||
    sourceType === 'episode')

if (shouldNotify) {
  const reader =
    await readUser(userId)
  const readerName =
    reader?.name ||
    reader?.username ||
    'A reader'
  const notificationTitle =
    sourceType === 'episode'
      ? source.content || 'your episode'
      : source.name || 'your story'

  await Promise.all([
    incrementAuthorPageAnalytics(
      authorPageId,
      'interactions'
    ),
    createAuthorStoryNotificationSafely({
      authorId: authorPageId,
      type: 'echo',
      title: `${readerName} echoed ${notificationTitle}`,
      message: echoText,
      targetUrl: source.url,
      sourceKey:
        `social-echo-v2:${data.id}`,
      metadata: {
        source_type: sourceType,
        source_id: sourceId,
        echo_id: data.id,
        destination,
        audience,
        share_count: Number(
          data.share_count || 1
        ),
        reader_id: userId,
        reader_name: readerName,
        reader_username:
          reader?.username || '',
        reader_avatar_url:
          reader?.avatar_url || '',
      },
    }),
  ]).catch((error) => {
    console.error(
      'ECHO V2 NOTIFICATION ERROR:',
      error
    )
  })
}

    const echo = await hydrateEcho(
      data,
      userId,
      source
    )
    const echoCount =
      await readSourceEchoCount(
        sourceType,
        sourceId
      )

    return res
      .status(created ? 201 : 200)
      .json({
        ok: true,
        created,
        echo_count: echoCount,
        limits: {
          same_source_remaining:
            reservation.sameSourceRemaining,
          daily_remaining:
            reservation.dailyRemaining,
        },
        echo: echo || data,
        source,
      })
  } catch (error) {
    if (
      reservedEventId &&
      !saved
    ) {
      await releaseShare(
        reservedEventId
      )
    }

    console.error(
      'CREATE ECHO V2 ERROR:',
      error
    )

    return sendError(
      res,
      error,
      'Failed to echo content'
    )
  }
}

export async function getEchoV2BySource(
  req,
  res
) {
  try {
    const viewerId = getUserId(req)
    const sourceType =
      normalizeSourceType(
        req.params.sourceType
      )
    const sourceId = cleanText(
      req.params.sourceId,
      120
    )

    const parsedLimit = Number.parseInt(
      req.query.limit,
      10
    )
    const parsedPage = Number.parseInt(
      req.query.page,
      10
    )

    const limit = Number.isFinite(
      parsedLimit
    )
      ? Math.min(
          50,
          Math.max(1, parsedLimit)
        )
      : 20

    const page = Number.isFinite(
      parsedPage
    )
      ? Math.max(1, parsedPage)
      : 1

    if (!sourceType || !sourceId) {
      return res.status(400).json({
        ok: false,
        message:
          'Valid source type and source ID are required',
      })
    }

    const source = await readSource(
      sourceType,
      sourceId,
      viewerId
    )

    if (!source) {
      return res.status(404).json({
        ok: false,
        message:
          'Source content is not available',
      })
    }

    const start = (page - 1) * limit
    const visibleNeeded =
      start + limit + 1
    const visibleEchoes = []
    const batchSize = 100

    let rawOffset = 0
    let exhausted = false

    while (
      visibleEchoes.length <
        visibleNeeded &&
      !exhausted
    ) {
      const { data, error } =
        await supabase
          .from('social_echoes_v2')
          .select('*')
          .eq(
            'source_type',
            sourceType
          )
          .eq('source_id', sourceId)
          .order('updated_at', {
            ascending: false,
          })
          .range(
            rawOffset,
            rawOffset + batchSize - 1
          )

      if (error) throw error

      const rows = Array.isArray(data)
        ? data
        : []

      if (!rows.length) {
        exhausted = true
        break
      }

      rawOffset += rows.length

      if (rows.length < batchSize) {
        exhausted = true
      }

      const hydratedBatch = (
        await Promise.all(
          rows.map((echo) =>
            hydrateEcho(
              echo,
              viewerId,
              source
            )
          )
        )
      ).filter(Boolean)

      visibleEchoes.push(
        ...hydratedBatch
      )
    }

    const echoes = visibleEchoes.slice(
      start,
      start + limit
    )
    const hasMore =
      visibleEchoes.length >
      start + limit

    const echoCount =
      await readSourceEchoCount(
        sourceType,
        sourceId
      )

    return res.status(200).json({
      ok: true,
      source_type: sourceType,
      source_id: sourceId,
      source,
      page,
      limit,
      has_more: hasMore,
      echo_count: echoCount,
      total: echoCount,
      echoes,
    })
  } catch (error) {
    console.error(
      'GET ECHO V2 SOURCE ERROR:',
      error
    )

    return sendError(
      res,
      error,
      'Failed to load source echoes'
    )
  }
}

function getEchoV2ListPage(req, fallbackLimit = 20) {
  const parsedPage = Number.parseInt(req.query.page, 10)
  const parsedLimit = Number.parseInt(req.query.limit, 10)

  return {
    page: Number.isFinite(parsedPage)
      ? Math.max(1, parsedPage)
      : 1,
    limit: Number.isFinite(parsedLimit)
      ? Math.min(50, Math.max(1, parsedLimit))
      : fallbackLimit,
  }
}

async function readEchoV2VisiblePage({
  viewerId,
  page,
  limit,
  configure,
}) {
  const start = (page - 1) * limit
  const visibleNeeded = start + limit + 1
  const visibleEchoes = []
  const batchSize = 100
  let rawOffset = 0
  let exhausted = false

  while (
    visibleEchoes.length < visibleNeeded &&
    !exhausted
  ) {
    let query = supabase
      .from('social_echoes_v2')
      .select('*')

    query = configure(query)

    const { data, error } = await query
      .order('updated_at', {
        ascending: false,
      })
      .range(
        rawOffset,
        rawOffset + batchSize - 1
      )

    if (error) throw error

    const rows = Array.isArray(data)
      ? data
      : []

    if (!rows.length) {
      exhausted = true
      break
    }

    rawOffset += rows.length

    if (rows.length < batchSize) {
      exhausted = true
    }

    const hydrated = (
      await Promise.all(
        rows.map((echo) =>
          hydrateEcho(
            echo,
            viewerId
          )
        )
      )
    ).filter(Boolean)

    visibleEchoes.push(...hydrated)
  }

  return {
    echoes: visibleEchoes.slice(
      start,
      start + limit
    ),
    hasMore:
      visibleEchoes.length >
      start + limit,
  }
}

export async function getEchoV2Feed(
  req,
  res
) {
  try {
    const viewerId = getUserId(req)
    const { page, limit } =
      getEchoV2ListPage(req, 20)

    const { echoes, hasMore } =
      await readEchoV2VisiblePage({
        viewerId,
        page,
        limit,
        configure: (query) =>
          query.eq(
            'destination',
            'feed'
          ),
      })

    return res.status(200).json({
      ok: true,
      page,
      limit,
      total: echoes.length,
      has_more: hasMore,
      echoes,
    })
  } catch (error) {
    return sendError(
      res,
      error,
      'Failed to load echo feed'
    )
  }
}

export async function getMyEchoV2(
  req,
  res
) {
  try {
    const userId = getUserId(req)
    const { page, limit } =
      getEchoV2ListPage(req, 30)

    const { echoes, hasMore } =
      await readEchoV2VisiblePage({
        viewerId: userId,
        page,
        limit,
        configure: (query) =>
          query
            .eq('user_id', userId)
            .in('destination', [
              'feed',
              'shadow',
            ]),
      })

    return res.status(200).json({
      ok: true,
      page,
      limit,
      total: echoes.length,
      has_more: hasMore,
      echoes,
    })
  } catch (error) {
    return sendError(
      res,
      error,
      'Failed to load your echoes'
    )
  }
}

export async function getReceivedEchoV2(
  req,
  res
) {
  try {
    const viewerId = getUserId(req)
    const { page, limit } =
      getEchoV2ListPage(req, 30)

    const { echoes, hasMore } =
      await readEchoV2VisiblePage({
        viewerId,
        page,
        limit,
        configure: (query) =>
          query
            .in('destination', [
              'reader',
              'circle',
            ])
            .contains(
              'selected_reader_ids',
              [viewerId]
            ),
      })

    return res.status(200).json({
      ok: true,
      page,
      limit,
      total: echoes.length,
      has_more: hasMore,
      echoes,
    })
  } catch (error) {
    return sendError(
      res,
      error,
      'Failed to load received echoes'
    )
  }
}

export async function getEchoV2ByUsername(
  req,
  res
) {
  try {
    const viewerId = getUserId(req)
    const username = cleanText(
      String(
        req.params.username || ''
      ).replace(/^@+/, ''),
      80
    )
    const { page, limit } =
      getEchoV2ListPage(req, 30)

    if (!username) {
      return res.status(400).json({
        ok: false,
        message: 'Username is required',
      })
    }

    const { data: user, error } =
      await supabase
        .from('users')
        .select(
          'id, name, username, avatar_url, is_active'
        )
        .ilike('username', username)
        .eq('is_active', true)
        .maybeSingle()

    if (error) throw error

    if (!user) {
      return res.status(404).json({
        ok: false,
        message: 'Reader not found',
      })
    }

    const { echoes, hasMore } =
      await readEchoV2VisiblePage({
        viewerId,
        page,
        limit,
        configure: (query) =>
          query
            .eq('user_id', user.id)
            .in('destination', [
              'feed',
              'shadow',
            ]),
      })

    return res.status(200).json({
      ok: true,
      user: normalizeUser(
        user,
        user.id
      ),
      page,
      limit,
      total: echoes.length,
      has_more: hasMore,
      echoes,
    })
  } catch (error) {
    return sendError(
      res,
      error,
      'Failed to load reader echoes'
    )
  }
}


export async function deleteEchoV2(
  req,
  res
) {
  let linkedReaderPostId = ''
  let linkedPostDeleted = false
  let echoDeleted = false
  let userId = ''

  try {
    userId = getUserId(req)
    const echoId = cleanText(
      req.params.echoId,
      120
    )

    const { data: current, error } =
      await supabase
        .from('social_echoes_v2')
        .select(
          'id, source_type, source_id'
        )
        .eq('id', echoId)
        .eq('user_id', userId)
        .maybeSingle()

    if (error) throw error

    if (!current) {
      return res.status(404).json({
        ok: false,
        message: 'Echo not found',
      })
    }

    linkedReaderPostId =
      await readLinkedReaderPostId(
        current.id,
        userId
      )

    if (linkedReaderPostId) {
      linkedPostDeleted =
        await setLinkedReaderPostDeleted(
          linkedReaderPostId,
          userId,
          true
        )
    }

    const { error: deleteError } =
      await supabase
        .from('social_echoes_v2')
        .delete()
        .eq('id', current.id)
        .eq('user_id', userId)

    if (deleteError) {
      throw deleteError
    }

    echoDeleted = true

    const echoCount =
      await readSourceEchoCount(
        current.source_type,
        current.source_id
      )

    return res.status(200).json({
      ok: true,
      echo_id: current.id,
      echo_count: echoCount,
      deleted_reader_post_id:
        linkedReaderPostId || null,
    })
  } catch (error) {
    if (
      linkedPostDeleted &&
      !echoDeleted &&
      linkedReaderPostId &&
      userId
    ) {
      try {
        await setLinkedReaderPostDeleted(
          linkedReaderPostId,
          userId,
          false
        )
      } catch (restoreError) {
        console.error(
          'RESTORE ECHO V2 READER POST ERROR:',
          restoreError
        )
      }
    }

    console.error(
      'DELETE ECHO V2 ERROR:',
      error
    )

    return sendError(
      res,
      error,
      'Failed to delete echo'
    )
  }
}
