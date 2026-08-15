import { supabase } from '../config/supabase.js'

const MAX_POST_LENGTH = 10000
const MAX_POST_IMAGES = 5
const MAX_PHOTO_CAPTION_LENGTH = 2000
const MAX_PHOTO_ALT_TEXT_LENGTH = 500
const DEFAULT_LIMIT = 20
const MAX_LIMIT = 30
const FEED_SCAN_LIMIT = 120

const VISIBILITIES = new Set([
  'public',
  'friends',
  'followers',
  'friends_and_followers',
  'only_me',
  'private',
])

const COMMENT_PERMISSIONS = new Set([
  'everyone',
  'friends',
  'followers',
  'no_one',
])

function getUserId(req) {
  return String(
    req.user?.user_id ||
      req.user?.id ||
      ''
  ).trim()
}

function normalizeUsername(value) {
  return String(value || '')
    .trim()
    .replace(/^@+/, '')
}

function escapeLikePattern(value) {
  return String(value || '').replace(/[\\%_]/g, '\\$&')
}

function getLimit(value) {
  const parsed = Number.parseInt(value, 10)

  if (!Number.isFinite(parsed)) {
    return DEFAULT_LIMIT
  }

  return Math.min(
    MAX_LIMIT,
    Math.max(1, parsed)
  )
}

function normalizeContent(value) {
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .trim()
}

function normalizeImageUrls(value) {
  if (
    value === undefined ||
    value === null
  ) {
    return []
  }

  if (!Array.isArray(value)) {
    const error = new Error(
      'Post images must be an array'
    )
    error.statusCode = 400
    throw error
  }

  const imageUrls = [
    ...new Set(
      value
        .filter(
          (item) =>
            typeof item === 'string'
        )
        .map((item) => item.trim())
        .filter(Boolean)
    ),
  ]

  if (
    imageUrls.length >
    MAX_POST_IMAGES
  ) {
    const error = new Error(
      `You can add up to ${MAX_POST_IMAGES} images per post`
    )
    error.statusCode = 400
    throw error
  }

  const invalidUrl = imageUrls.find(
    (url) =>
      !/^https?:\/\/\S+$/i.test(url)
  )

  if (invalidUrl) {
    const error = new Error(
      'Post image URL is invalid'
    )
    error.statusCode = 400
    throw error
  }

  return imageUrls
}

function normalizePhotoMetadata(
  value,
  imageUrls = [],
  fallback = []
) {
  const images = Array.isArray(
    imageUrls
  )
    ? imageUrls
    : []

  const source =
    value === undefined
      ? fallback
      : value

  if (
    source !== null &&
    !Array.isArray(source)
  ) {
    const error = new Error(
      'Photo metadata must be an array'
    )
    error.statusCode = 400
    throw error
  }

  const items = Array.isArray(source)
    ? source
    : []

  const byUrl = new Map()

  for (const item of items) {
    if (
      !item ||
      typeof item !== 'object' ||
      Array.isArray(item)
    ) {
      continue
    }

    const url = String(
      item.url || ''
    ).trim()

    if (url) {
      byUrl.set(url, item)
    }
  }

  return images.map(
    (url, index) => {
      const indexedItem =
        items[index] &&
        typeof items[index] ===
          'object' &&
        !Array.isArray(items[index])
          ? items[index]
          : {}

      const item =
        byUrl.get(url) ||
        indexedItem

      const caption = String(
        item.caption || ''
      )
        .replace(/\r\n/g, '\n')
        .trim()

      const altText = String(
        item.alt_text ??
          item.alt ??
          ''
      )
        .replace(/\r\n/g, '\n')
        .trim()

      if (
        caption.length >
        MAX_PHOTO_CAPTION_LENGTH
      ) {
        const error = new Error(
          `Photo caption must be ${MAX_PHOTO_CAPTION_LENGTH} characters or fewer`
        )
        error.statusCode = 400
        throw error
      }

      if (
        altText.length >
        MAX_PHOTO_ALT_TEXT_LENGTH
      ) {
        const error = new Error(
          `Photo alt text must be ${MAX_PHOTO_ALT_TEXT_LENGTH} characters or fewer`
        )
        error.statusCode = 400
        throw error
      }

      return {
        url,
        caption,
        alt_text: altText,
      }
    }
  )
}

function validateContent(
  value,
  imageUrls = [],
  allowEmpty = false
) {
  const content = normalizeContent(value)

  if (
    !allowEmpty &&
    !content &&
    !imageUrls.length
  ) {
    const error = new Error(
      'Post text or image is required'
    )
    error.statusCode = 400
    throw error
  }

  if (content.length > MAX_POST_LENGTH) {
    const error = new Error(
      `Post text must be ${MAX_POST_LENGTH} characters or fewer`
    )
    error.statusCode = 400
    throw error
  }

  return content
}

function normalizeVisibility(
  value,
  fallback = 'public'
) {
  const normalized = String(
    value || fallback
  )
    .trim()
    .toLowerCase()

  return VISIBILITIES.has(normalized)
    ? normalized
    : fallback
}

function normalizeCommentsPermission(
  value,
  fallback = 'everyone'
) {
  const normalized = String(
    value || fallback
  )
    .trim()
    .toLowerCase()

  return COMMENT_PERMISSIONS.has(
    normalized
  )
    ? normalized
    : fallback
}

function normalizePublishAt(value) {
  const date = value
    ? new Date(value)
    : new Date()

  if (Number.isNaN(date.getTime())) {
    return new Date().toISOString()
  }

  return date.toISOString()
}

function normalizeUser(user) {
  if (!user) return null

  return {
    id: user.id,
    name: user.name || 'Reader',
    username: user.username || '',
    avatar_url: user.avatar_url || null,
    is_following: Boolean(user.is_following),
  }
}

function normalizePost(
  post,
  user,
  viewerId
) {
  const imageUrls = Array.isArray(
    post.image_urls
  )
    ? post.image_urls
        .filter(
          (url) =>
            typeof url === 'string' &&
            url.trim()
        )
        .slice(0, MAX_POST_IMAGES)
    : []

  return {
    id: post.id,
    user_id: post.user_id,
    content: post.content || '',
    image_urls: imageUrls,
    photo_metadata:
      normalizePhotoMetadata(
        post.photo_metadata,
        imageUrls
      ),
    visibility:
      post.visibility || 'public',
    comments_permission:
      post.comments_permission ||
      'everyone',
    story_sharing: Boolean(
      post.story_sharing
    ),
    publish_at:
      post.publish_at ||
      post.created_at,
    like_count: Number(
      post.like_count || 0
    ),
    comment_count: Number(
      post.comment_count || 0
    ),
    echo_count: Number(
      post.echo_count || 0
    ),
    created_at: post.created_at,
    updated_at: post.updated_at,
    is_edited:
      Boolean(post.updated_at) &&
      Boolean(post.created_at) &&
      new Date(
        post.updated_at
      ).getTime() >
        new Date(
          post.created_at
        ).getTime() +
          1000,
    is_owner:
      Boolean(viewerId) &&
      String(post.user_id) ===
        String(viewerId),
    user: normalizeUser(user),
  }
}

async function readUsersByIds(userIds) {
  const ids = [
    ...new Set(
      (userIds || [])
        .map((id) => String(id || ''))
        .filter(Boolean)
    ),
  ]

  if (!ids.length) return new Map()

  const { data, error } = await supabase
    .from('users')
    .select(
      'id, name, username, avatar_url, is_active'
    )
    .in('id', ids)

  if (error) throw error

  return new Map(
    (data || [])
      .filter(
        (user) =>
          user.is_active !== false
      )
      .map((user) => [
        String(user.id),
        user,
      ])
  )
}

async function getRelationshipMaps(
  viewerId,
  ownerIds
) {
  const ids = [
    ...new Set(
      (ownerIds || [])
        .map((id) => String(id || ''))
        .filter(
          (id) =>
            id &&
            id !== String(viewerId)
        )
    ),
  ]

  const empty = {
    viewerFollowsOwners: new Set(),
    ownersFollowViewer: new Set(),
  }

  if (!viewerId || !ids.length) {
    return empty
  }

  const [
    viewerFollowingResult,
    viewerFollowersResult,
  ] = await Promise.all([
    supabase
      .from('user_follows')
      .select('following_user_id')
      .eq(
        'follower_user_id',
        viewerId
      )
      .in('following_user_id', ids),
    supabase
      .from('user_follows')
      .select('follower_user_id')
      .eq(
        'following_user_id',
        viewerId
      )
      .in('follower_user_id', ids),
  ])

  if (viewerFollowingResult.error) {
    throw viewerFollowingResult.error
  }

  if (viewerFollowersResult.error) {
    throw viewerFollowersResult.error
  }

  return {
    viewerFollowsOwners: new Set(
      (
        viewerFollowingResult.data || []
      ).map((row) =>
        String(row.following_user_id)
      )
    ),
    ownersFollowViewer: new Set(
      (
        viewerFollowersResult.data || []
      ).map((row) =>
        String(row.follower_user_id)
      )
    ),
  }
}

function canViewerSeePost(
  post,
  viewerId,
  relationships
) {
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

  const visibility =
    normalizeVisibility(
      post.visibility,
      'public'
    )

  if (visibility === 'public') {
    return true
  }

  if (
    visibility === 'only_me' ||
    visibility === 'private'
  ) {
    return false
  }

  const viewerFollowsOwner =
    relationships.viewerFollowsOwners.has(
      ownerId
    )

  const ownerFollowsViewer =
    relationships.ownersFollowViewer.has(
      ownerId
    )

  if (visibility === 'followers') {
    return viewerFollowsOwner
  }

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

function uniqueStrings(values) {
  return [
    ...new Set(
      (values || [])
        .map((value) =>
          String(value || '').trim()
        )
        .filter(Boolean)
    ),
  ]
}

async function readReaderPostEchoCounts(
  postIds
) {
  const ids = uniqueStrings(postIds)

  if (!ids.length) return new Map()

  const [v2Result, legacyResult] =
    await Promise.all([
      supabase
        .from('social_echoes_v2')
        .select(
          'user_id, source_id, share_count'
        )
        .eq(
          'source_type',
          'reader_post'
        )
        .in('source_id', ids),
      supabase
        .from('social_echoes')
        .select(
          'user_id, source_id, share_count'
        )
        .eq(
          'source_type',
          'reader_post'
        )
        .in('source_id', ids),
    ])

  if (v2Result.error) {
    throw v2Result.error
  }

  if (legacyResult.error) {
    throw legacyResult.error
  }

  const preferred = new Map()

  for (const row of legacyResult.data || []) {
    const key = `${String(
      row.user_id || ''
    )}:${String(row.source_id || '')}`

    preferred.set(key, row)
  }

  for (const row of v2Result.data || []) {
    const key = `${String(
      row.user_id || ''
    )}:${String(row.source_id || '')}`

    preferred.set(key, row)
  }

  const counts = new Map()

  for (const row of preferred.values()) {
    const id = String(row.source_id || '')
    const next =
      Number(counts.get(id) || 0) +
      Math.max(
        1,
        Number(row.share_count || 1)
      )

    counts.set(id, next)
  }

  return counts
}

async function readLinkedEchoPostIds(
  postIds
) {
  const ids = uniqueStrings(postIds)

  if (!ids.length) return new Set()

  const [v2Result, legacyResult] =
    await Promise.all([
      supabase
        .from(
          'social_echo_reader_posts_v2'
        )
        .select('reader_post_id')
        .in('reader_post_id', ids),
      supabase
        .from('social_echoes')
        .select('reader_post_id')
        .in('reader_post_id', ids),
    ])

  if (v2Result.error) {
    throw v2Result.error
  }

  if (legacyResult.error) {
    throw legacyResult.error
  }

  return new Set(
    [
      ...(v2Result.data || []),
      ...(legacyResult.data || []),
    ]
      .map((row) =>
        String(row.reader_post_id || '')
      )
      .filter(Boolean)
  )
}

async function readLinkedEchoByPostId(
  postId,
  userId
) {
  if (!postId || !userId) return null

  const { data: v2Link, error: linkError } =
    await supabase
      .from(
        'social_echo_reader_posts_v2'
      )
      .select(
  'echo_id, reader_post_id, updated_at'
)
      .eq('reader_post_id', postId)
      .eq('user_id', userId)
      .maybeSingle()

  if (linkError) throw linkError

  if (v2Link?.echo_id) {
    const { data, error } = await supabase
      .from('social_echoes_v2')
      .select(
        'id, user_id, source_type, source_id, echo_text, destination, audience, selected_reader_ids, share_count, created_at, updated_at'
      )
      .eq('id', v2Link.echo_id)
      .eq('user_id', userId)
      .maybeSingle()

    if (error) throw error

    if (data) {
      return {
        ...data,
        reader_post_id:
          v2Link.reader_post_id,
        echo_version: 'v2',
      }
    }
  }

  const { data, error } = await supabase
    .from('social_echoes')
    .select(
      'id, user_id, source_type, source_id, reader_post_id, echo_text, destination, audience, selected_reader_ids, share_count, created_at, updated_at'
    )
    .eq('reader_post_id', postId)
    .eq('user_id', userId)
    .maybeSingle()

  if (error) throw error

  return data
    ? {
        ...data,
        echo_version: 'legacy',
      }
    : null
}

async function attachVisibleUsers(
  posts,
  viewerId
) {
  const rows = Array.isArray(posts)
    ? posts
    : []

  const ownerIds = rows
    .map((post) => post?.user_id)
    .filter(Boolean)
  const postIds = rows
    .map((post) => post?.id)
    .filter(Boolean)

  const [
    userMap,
    relationships,
    echoCounts,
  ] = await Promise.all([
    readUsersByIds(ownerIds),
    getRelationshipMaps(
      viewerId,
      ownerIds
    ),
    readReaderPostEchoCounts(postIds),
  ])

  return rows
    .filter((post) =>
      canViewerSeePost(
        post,
        viewerId,
        relationships
      )
    )
    .map((post) => {
      const user = userMap.get(
        String(post.user_id)
      )
      const storedCount = Number(
        post.echo_count || 0
      )
      const universalCount = Number(
        echoCounts.get(String(post.id)) ||
          0
      )

      return user
        ? normalizePost(
            {
              ...post,
              echo_count: Math.max(
                storedCount,
                universalCount
              ),
            },
                        {
              ...user,
              is_following:
                relationships.viewerFollowsOwners.has(String(post.user_id)),
            },
            viewerId
          )
        : null
    })
    .filter(Boolean)
}

function echoAudienceToVisibility(
  audience
) {
  if (audience === 'only-me') {
    return 'only_me'
  }

  if (audience === 'followers') {
    return 'followers'
  }

  if (audience === 'close-readers') {
    return 'friends'
  }

  return 'public'
}

function canViewerSeeEcho(
  echo,
  viewerId,
  relationships
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

  if (echo.audience === 'only-me') {
    return false
  }

  if (echo.audience === 'followers') {
    return relationships.viewerFollowsOwners.has(
      ownerId
    )
  }

  if (
    echo.audience === 'close-readers'
  ) {
    return selectedReaderIds.includes(
      currentViewerId
    )
  }

  return false
}

function mergeTimelinePosts(
  groups,
  limit
) {
  const seen = new Set()

  return groups
    .flat()
    .filter(Boolean)
    .sort((left, right) => {
      const rightTime = new Date(
        right.publish_at ||
          right.updated_at ||
          right.created_at ||
          0
      ).getTime()
      const leftTime = new Date(
        left.publish_at ||
          left.updated_at ||
          left.created_at ||
          0
      ).getTime()

      if (rightTime !== leftTime) {
        return rightTime - leftTime
      }

      return String(
        right.id || ''
      ).localeCompare(
        String(left.id || '')
      )
    })
    .filter((post) => {
      const id = String(post.id || '')

      if (!id || seen.has(id)) {
        return false
      }

      seen.add(id)
      return true
    })
    .slice(0, limit)
}

async function createV2EchoReaderPost(
  echo
) {
  const userId = String(
    echo?.user_id || ''
  )
  const echoId = String(
    echo?.id || ''
  )

  if (!userId || !echoId) {
    return null
  }

  const {
    data: existingLink,
    error: existingLinkError,
  } = await supabase
    .from(
      'social_echo_reader_posts_v2'
    )
    .select('echo_id, reader_post_id, updated_at')
.eq('echo_id', echoId)
.maybeSingle()

  if (existingLinkError) {
    throw existingLinkError
  }

  if (existingLink?.reader_post_id) {
  await syncV2EchoReaderPost(
    echo,
    existingLink
  )

  return existingLink
}

  const timestamp =
    echo.updated_at ||
    echo.created_at ||
    new Date().toISOString()

  const { data: post, error: postError } =
    await supabase
      .from('reader_posts')
      .insert({
        user_id: userId,
        content: String(
          echo.echo_text || ''
        ).trim(),
        image_urls: [],
        visibility:
          echoAudienceToVisibility(
            echo.audience
          ),
        comments_permission: 'everyone',
        story_sharing: true,
        publish_at: timestamp,
        like_count: 0,
        comment_count: 0,
        echo_count: 0,
        created_at: timestamp,
        updated_at: timestamp,
      })
      .select('id')
      .single()

  if (postError) throw postError

  const { data: link, error: linkError } =
    await supabase
      .from(
        'social_echo_reader_posts_v2'
      )
      .insert({
        echo_id: echoId,
        reader_post_id: post.id,
        user_id: userId,
        created_at: timestamp,
        updated_at: timestamp,
      })
      .select(
        'echo_id, reader_post_id'
      )
      .single()

  if (!linkError) {
    return link
  }

  await supabase
    .from('reader_posts')
    .update({
      deleted_at:
        new Date().toISOString(),
      updated_at:
        new Date().toISOString(),
    })
    .eq('id', post.id)
    .eq('user_id', userId)
    .is('deleted_at', null)

  const {
    data: concurrentLink,
    error: concurrentError,
  } = await supabase
    .from(
      'social_echo_reader_posts_v2'
    )
    .select('echo_id, reader_post_id')
    .eq('echo_id', echoId)
    .maybeSingle()

  if (concurrentError) {
    throw concurrentError
  }

  if (concurrentLink) {
    return concurrentLink
  }

  throw linkError
}

async function syncV2EchoReaderPost(
  echo,
  link
) {
  if (!echo?.id || !link?.reader_post_id) {
    return
  }

  const updatedAt =
    echo.updated_at ||
    echo.created_at ||
    new Date().toISOString()

  const echoTime =
    new Date(updatedAt).getTime()
  const linkTime =
    new Date(
      link.updated_at || 0
    ).getTime()

  if (
    Number.isFinite(linkTime) &&
    linkTime >= echoTime
  ) {
    return
  }

  const { error: postError } =
    await supabase
      .from('reader_posts')
      .update({
        content: String(
          echo.echo_text || ''
        ).trim(),
        visibility:
          echoAudienceToVisibility(
            echo.audience
          ),
        publish_at: updatedAt,
        updated_at: updatedAt,
      })
      .eq(
        'id',
        link.reader_post_id
      )
      .eq('user_id', echo.user_id)
      .is('deleted_at', null)

  if (postError) throw postError

  const { error: linkError } =
    await supabase
      .from(
        'social_echo_reader_posts_v2'
      )
      .update({
        updated_at: updatedAt,
      })
      .eq('echo_id', echo.id)
      .eq(
        'reader_post_id',
        link.reader_post_id
      )

  if (linkError) throw linkError
}

async function ensureV2EchoLinks(
  echoes
) {
  const rows = Array.isArray(echoes)
    ? echoes
    : []

  if (!rows.length) return new Map()

  const echoIds = uniqueStrings(
    rows.map((echo) => echo.id)
  )

  const { data, error } = await supabase
    .from(
      'social_echo_reader_posts_v2'
    )
    .select(
  'echo_id, reader_post_id, updated_at'
)
    .in('echo_id', echoIds)

  if (error) throw error

  const linkMap = new Map(
    (data || []).map((link) => [
      String(link.echo_id),
      link,
    ])
  )

  await Promise.all(
  rows.map((echo) => {
    const link = linkMap.get(
      String(echo.id)
    )

    return link
      ? syncV2EchoReaderPost(
          echo,
          link
        )
      : null
  })
)

  const missing = rows.filter(
    (echo) =>
      !linkMap.has(String(echo.id))
  )

  if (missing.length) {
    const created = await Promise.all(
      missing.map((echo) =>
        createV2EchoReaderPost(echo)
      )
    )

    for (const link of created) {
      if (link?.echo_id) {
        linkMap.set(
          String(link.echo_id),
          link
        )
      }
    }
  }

  return linkMap
}

async function readCombinedEchoRows({
  ownerId = '',
  echoId = '',
  echoVersion = '',
  feedOnly = false,
  limit = FEED_SCAN_LIMIT,
}) {
  let v2Query = supabase
    .from('social_echoes_v2')
    .select(
      'id, user_id, source_type, source_id, echo_text, destination, audience, selected_reader_ids, share_count, created_at, updated_at'
    )
    .order('updated_at', {
      ascending: false,
    })
    .limit(limit)

  let legacyQuery = supabase
    .from('social_echoes')
    .select(
      'id, user_id, source_type, source_id, reader_post_id, echo_text, destination, audience, selected_reader_ids, share_count, created_at, updated_at'
    )
    .order('updated_at', {
      ascending: false,
    })
    .limit(limit)

  if (feedOnly) {
    v2Query = v2Query.eq(
      'destination',
      'feed'
    )
    legacyQuery = legacyQuery.eq(
      'destination',
      'feed'
    )
  } else {
    v2Query = v2Query.in(
      'destination',
      ['feed', 'shadow']
    )
    legacyQuery = legacyQuery.in(
      'destination',
      ['feed', 'shadow']
    )
  }

  if (ownerId) {
    v2Query = v2Query.eq(
      'user_id',
      ownerId
    )
    legacyQuery = legacyQuery.eq(
      'user_id',
      ownerId
    )
  }

  if (echoId && echoVersion !== 'legacy') {
    v2Query = v2Query.eq('id', echoId)
  }

  if (echoId && echoVersion !== 'v2') {
    legacyQuery = legacyQuery.eq('id', echoId)
  }

  const [v2Result, legacyResult] =
    await Promise.all([
      echoVersion === 'legacy'
        ? Promise.resolve({
            data: [],
            error: null,
          })
        : v2Query,
      echoVersion === 'v2'
        ? Promise.resolve({
            data: [],
            error: null,
          })
        : legacyQuery,
    ])

  if (v2Result.error) {
    throw v2Result.error
  }

  if (legacyResult.error) {
    throw legacyResult.error
  }

  const v2Rows = Array.isArray(
    v2Result.data
  )
    ? v2Result.data
    : []
  const legacyRows = Array.isArray(
    legacyResult.data
  )
    ? legacyResult.data
    : []

  const v2Links =
    await ensureV2EchoLinks(v2Rows)

  const normalizedV2 = v2Rows.map(
    (echo) => ({
      ...echo,
      reader_post_id:
        v2Links.get(String(echo.id))
          ?.reader_post_id || null,
      echo_version: 'v2',
    })
  )

  const v2Keys = new Set(
    normalizedV2.map(
      (echo) =>
        `${String(
          echo.user_id || ''
        )}:${String(
          echo.source_type || ''
        )}:${String(
          echo.source_id || ''
        )}`
    )
  )

  const legacyFallback = legacyRows
    .filter((echo) => {
      const key = `${String(
        echo.user_id || ''
      )}:${String(
        echo.source_type || ''
      )}:${String(
        echo.source_id || ''
      )}`

      return !v2Keys.has(key)
    })
    .map((echo) => ({
      ...echo,
      echo_version: 'legacy',
    }))

  return [
    ...normalizedV2,
    ...legacyFallback,
  ]
    .sort(
      (left, right) =>
        new Date(
          right.updated_at ||
            right.created_at ||
            0
        ).getTime() -
        new Date(
          left.updated_at ||
            left.created_at ||
            0
        ).getTime()
    )
    .slice(0, limit)
}

async function readSocialEchoPosts({
  viewerId,
  ownerId = '',
  echoId = '',
  echoVersion = '',
  feedOnly = false,
  limit = FEED_SCAN_LIMIT,
}) {
  const echoes =
    await readCombinedEchoRows({
      ownerId,
      echoId,
      echoVersion,
      feedOnly,
      limit,
    })

  if (!echoes.length) return []

  const sourceIds = {
    story: [],
    episode: [],
    reader_post: [],
    author_post: [],
    shadow_mall_promotion: [],
  }

  for (const echo of echoes) {
    if (sourceIds[echo.source_type]) {
      sourceIds[echo.source_type].push(
        String(echo.source_id || '')
      )
    }
  }

  const storyIds = uniqueStrings(
    sourceIds.story
  )
  const episodeIds = uniqueStrings(
    sourceIds.episode
  )
  const readerPostIds = uniqueStrings(
    sourceIds.reader_post
  )
  const authorPostIds = uniqueStrings(
    sourceIds.author_post
  )
  const promotionIds = uniqueStrings(
    sourceIds.shadow_mall_promotion
  )
  const linkedReaderPostIds =
    uniqueStrings(
      echoes.map((echo) =>
        echo.reader_post_id
      )
    )

  const [
    storyResult,
    episodeResult,
    readerPostResult,
    authorPostResult,
    promotionResult,
    linkedReaderPostResult,
  ] = await Promise.all([
    storyIds.length
      ? supabase
          .from('stories')
          .select(
            'id, author_id, user_id, title, cover_url, landscape_thumbnail_url, main_genre, status, deleted_at'
          )
          .in('id', storyIds)
          .is('deleted_at', null)
      : Promise.resolve({
          data: [],
          error: null,
        }),
    episodeIds.length
      ? supabase
          .from('episodes')
          .select(
            'id, story_id, title, episode_number, cover_url, published_at, status, deleted_at'
          )
          .in('id', episodeIds)
          .is('deleted_at', null)
      : Promise.resolve({
          data: [],
          error: null,
        }),
    readerPostIds.length
      ? supabase
          .from('reader_posts')
          .select(
            'id, user_id, content, image_urls, photo_metadata, visibility, publish_at, created_at, deleted_at'
          )
          .in('id', readerPostIds)
          .is('deleted_at', null)
      : Promise.resolve({
          data: [],
          error: null,
        }),
    authorPostIds.length
      ? supabase
          .from('author_page_posts')
          .select(
            'id, author_page_id, user_id, content, image_urls, status, created_at, author_page:author_pages(id, user_id, page_name, page_username, avatar_url)'
          )
          .in('id', authorPostIds)
          .eq('status', 'active')
      : Promise.resolve({
          data: [],
          error: null,
        }),
    promotionIds.length
      ? supabase
          .from('shadow_mall_ads')
          .select(
            'id, sponsor, title, description, button_text, link_url, promotion_type, story_id, profile_image_url, image_url, is_active, created_at, updated_at'
          )
          .in('id', promotionIds)
          .eq('is_active', true)
      : Promise.resolve({
          data: [],
          error: null,
        }),
    linkedReaderPostIds.length
      ? supabase
          .from('reader_posts')
          .select(
            'id, user_id, content, image_urls, photo_metadata, visibility, comments_permission, story_sharing, publish_at, like_count, comment_count, echo_count, created_at, updated_at, deleted_at'
          )
          .in(
            'id',
            linkedReaderPostIds
          )
          .is('deleted_at', null)
      : Promise.resolve({
          data: [],
          error: null,
        }),
  ])

  for (const result of [
    storyResult,
    episodeResult,
    readerPostResult,
    authorPostResult,
    promotionResult,
    linkedReaderPostResult,
  ]) {
    if (result.error) throw result.error
  }

  const episodes =
    episodeResult.data || []
  const episodeStoryIds = uniqueStrings(
    episodes.map((episode) =>
      episode.story_id
    )
  )
  let stories =
    storyResult.data || []
  const loadedStoryIds = new Set(
    stories.map((story) =>
      String(story.id)
    )
  )
  const missingStoryIds =
    episodeStoryIds.filter(
      (id) => !loadedStoryIds.has(id)
    )

  if (missingStoryIds.length) {
    const {
      data: extraStories,
      error,
    } = await supabase
      .from('stories')
      .select(
        'id, author_id, user_id, title, cover_url, landscape_thumbnail_url, main_genre, status, deleted_at'
      )
      .in('id', missingStoryIds)
      .is('deleted_at', null)

    if (error) throw error

    stories = [
      ...stories,
      ...(extraStories || []),
    ]
  }

  const authorPageIds = uniqueStrings(
    stories.map((story) =>
      story.author_id
    )
  )
  let authorPages = []

  if (authorPageIds.length) {
    const { data: pages, error } =
      await supabase
        .from('author_pages')
        .select(
          'id, user_id, page_name, page_username, avatar_url'
        )
        .in('id', authorPageIds)

    if (error) throw error
    authorPages = pages || []
  }

  const readerPosts =
    readerPostResult.data || []
  const authorPosts =
    authorPostResult.data || []
  const promotions =
    promotionResult.data || []
  const linkedReaderPosts =
    linkedReaderPostResult.data || []

  const linkedEchoCounts =
    await readReaderPostEchoCounts(
      linkedReaderPostIds
    )

  const sourceReaderUserIds =
    readerPosts.map((post) =>
      post.user_id
    )
  const echoOwnerIds = echoes.map(
    (echo) => echo.user_id
  )
  const relationshipOwnerIds = [
    ...echoOwnerIds,
    ...sourceReaderUserIds,
  ]
  const [userMap, relationships] =
    await Promise.all([
      readUsersByIds(
        relationshipOwnerIds
      ),
      getRelationshipMaps(
        viewerId,
        relationshipOwnerIds
      ),
    ])

  const storyMap = new Map(
    stories.map((story) => [
      String(story.id),
      story,
    ])
  )
  const episodeMap = new Map(
    episodes.map((episode) => [
      String(episode.id),
      episode,
    ])
  )
  const readerPostMap = new Map(
    readerPosts.map((post) => [
      String(post.id),
      post,
    ])
  )
  const authorPostMap = new Map(
    authorPosts.map((post) => [
      String(post.id),
      post,
    ])
  )
  const promotionMap = new Map(
    promotions.map((promotion) => [
      String(promotion.id),
      promotion,
    ])
  )
  const authorPageMap = new Map(
    authorPages.map((page) => [
      String(page.id),
      page,
    ])
  )
  const linkedReaderPostMap =
    new Map(
      linkedReaderPosts.map((post) => [
        String(post.id),
        post,
      ])
    )

  return echoes
    .filter((echo) =>
      canViewerSeeEcho(
        echo,
        viewerId,
        relationships
      )
    )
    .map((echo) => {
      const user = userMap.get(
        String(echo.user_id)
      )

      if (!user) return null

      let source = null
      let sourceStory = null
      let sourceEpisode = null
      let sourceReaderPost = null
      let sourceAuthorPost = null
      let sourcePromotion = null

      if (echo.source_type === 'story') {
        const story = storyMap.get(
          String(echo.source_id)
        )

        if (
          !story ||
          String(story.status || '')
            .toLowerCase() !==
            'published'
        ) {
          return null
        }

        const authorPage =
          authorPageMap.get(
            String(story.author_id || '')
          ) || null
        const imageUrl =
          story.landscape_thumbnail_url ||
          story.cover_url ||
          ''

        sourceStory = {
          id: story.id,
          title: story.title || 'Story',
          cover_url:
            story.cover_url || '',
          landscape_thumbnail_url:
            story.landscape_thumbnail_url ||
            '',
          main_genre:
            story.main_genre || '',
          author_page: authorPage,
        }
        source = {
          type: 'story',
          id: story.id,
          name:
            story.title || 'Story',
          content: '',
          image_url: imageUrl,
          image_urls: imageUrl
            ? [imageUrl]
            : [],
          url: `/story/${story.id}`,
          label: 'story',
          owner: authorPage,
        }
      }

      if (echo.source_type === 'episode') {
        const episode = episodeMap.get(
          String(echo.source_id)
        )
        const story = episode
          ? storyMap.get(
              String(episode.story_id)
            )
          : null

        if (
          !episode ||
          !story ||
          String(episode.status || '')
            .toLowerCase() !==
            'published' ||
          String(story.status || '')
            .toLowerCase() !==
            'published'
        ) {
          return null
        }

        const authorPage =
          authorPageMap.get(
            String(story.author_id || '')
          ) || null
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

        sourceStory = {
          id: story.id,
          title:
            story.title || 'Story',
          cover_url:
            story.cover_url || '',
          landscape_thumbnail_url:
            story.landscape_thumbnail_url ||
            '',
          main_genre:
            story.main_genre || '',
          author_page: authorPage,
        }
        sourceEpisode = {
          id: episode.id,
          story_id: episode.story_id,
          title: episodeTitle,
          episode_number: Number(
            episode.episode_number || 0
          ),
          cover_url:
            episode.cover_url || '',
        }
        source = {
          type: 'episode',
          id: episode.id,
          name:
            story.title || 'Story',
          content: episodeTitle,
          image_url: imageUrl,
          image_urls: imageUrl
            ? [imageUrl]
            : [],
          url:
            `/story/${story.id}/episode/${episode.id}`,
          label: 'episode',
          owner: authorPage,
        }
      }

      if (
        echo.source_type ===
        'reader_post'
      ) {
        const post = readerPostMap.get(
          String(echo.source_id)
        )

        const sourceIsFuture =
          Boolean(post?.publish_at) &&
          new Date(
            post.publish_at
          ).getTime() > Date.now()
        const viewerOwnsSource =
          String(post?.user_id || '') ===
          String(viewerId || '')

        if (
          !post ||
          (sourceIsFuture &&
            !viewerOwnsSource) ||
          !canViewerSeePost(
            post,
            viewerId,
            relationships
          )
        ) {
          return null
        }

        const sourceUser = userMap.get(
          String(post.user_id)
        )

        if (!sourceUser) return null

        const images = Array.isArray(
          post.image_urls
        )
          ? post.image_urls.filter(Boolean)
          : []
        const sourceOwner =
          normalizeUser(sourceUser)

        sourceReaderPost = {
          id: post.id,
          user_id: post.user_id,
          content: post.content || '',
          image_urls: images,
          photo_metadata:
          post.photo_metadata || [],
          visibility:
            post.visibility || 'public',
          publish_at:
            post.publish_at || null,
          created_at:
            post.created_at || null,
          user: sourceOwner,
        }
        source = {
          type: 'reader_post',
          id: post.id,
          name:
            sourceUser.name ||
            sourceUser.username ||
            'Reader Post',
          content: post.content || '',
          image_url: images[0] || '',
image_urls: images,
photo_metadata:
  post.photo_metadata || [],
url:
            sourceUser.username
              ? `/profile?username=${encodeURIComponent(
                  sourceUser.username
                )}#reader-post-${post.id}`
              : `/profile#reader-post-${post.id}`,
          label: 'reader post',
          created_at:
            post.created_at ||
            post.publish_at ||
            null,
          owner: sourceOwner,
        }
      }

      if (
        echo.source_type ===
        'author_post'
      ) {
        const post = authorPostMap.get(
          String(echo.source_id)
        )

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

        sourceAuthorPost = {
          id: post.id,
          author_page_id:
            post.author_page_id,
          user_id: post.user_id,
          content: post.content || '',
          image_urls: images,
          created_at:
            post.created_at || null,
          author_page:
            authorPage || null,
        }
        source = {
          type: 'author_post',
          id: post.id,
          name:
            authorPage?.page_name ||
            'Author Post',
          content: post.content || '',
          image_url: images[0] || '',
          image_urls: images,
          url:
            authorPage?.page_username
              ? `/author/page/${encodeURIComponent(
                  authorPage.page_username
                )}?post=${encodeURIComponent(
                  post.id
                )}`
              : '/',
          label: 'author post',
          created_at:
            post.created_at || null,
          owner: authorPage || null,
        }
      }

      if (
        echo.source_type ===
        'shadow_mall_promotion'
      ) {
        const promotion =
          promotionMap.get(
            String(echo.source_id)
          )

        if (!promotion) return null

        const imageUrl =
          promotion.image_url ||
          promotion.profile_image_url ||
          ''

        sourcePromotion = {
          id: promotion.id,
          sponsor:
            promotion.sponsor ||
            'Shadow Mall',
          title:
            promotion.title || '',
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
        }

        source = {
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
          url:
            promotion.link_url ||
            (promotion.story_id
              ? `/story/${promotion.story_id}`
              : '/shop'),
          label:
            'Shadow Mall promotion',
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
          promotion: sourcePromotion,
        }
      }

      if (!source) return null

      const linkedPost =
        linkedReaderPostMap.get(
          String(
            echo.reader_post_id || ''
          )
        ) || null

      if (
        echo.reader_post_id &&
        !linkedPost
      ) {
        return null
      }

      const echoTime =
        echo.updated_at ||
        echo.created_at
      const echoText = String(
        echo.echo_text || ''
      ).trim()
      const createdAt =
        linkedPost?.created_at ||
        echo.created_at ||
        echoTime
      const updatedAt =
        linkedPost?.updated_at ||
        echoTime
      const isEdited =
        Boolean(linkedPost?.updated_at) &&
        Boolean(linkedPost?.created_at) &&
        new Date(
          linkedPost.updated_at
        ).getTime() >
          new Date(
            linkedPost.created_at
          ).getTime() +
            1000
      const storedEchoCount = Number(
        linkedPost?.echo_count || 0
      )
      const universalEchoCount = Number(
        linkedEchoCounts.get(
          String(linkedPost?.id || '')
        ) || 0
      )

      return {
        id:
          linkedPost?.id ||
          `${
            echo.echo_version === 'v2'
              ? 'echo-v2'
              : 'social-echo'
          }:${echo.id}`,
        user_id: echo.user_id,
        content:
          linkedPost?.content ??
          echoText,
        image_urls:
  Array.isArray(
    linkedPost?.image_urls
  )
    ? linkedPost.image_urls
    : [],
photo_metadata:
  linkedPost?.photo_metadata || [],
visibility:
          linkedPost?.visibility ||
          echoAudienceToVisibility(
            echo.audience
          ),
        comments_permission:
          linkedPost?.comments_permission ||
          'no_one',
        story_sharing: true,
        publish_at:
          linkedPost?.publish_at ||
          echoTime,
        like_count: Number(
          linkedPost?.like_count || 0
        ),
        comment_count: Number(
          linkedPost?.comment_count || 0
        ),
        echo_count: Math.max(
          storedEchoCount,
          universalEchoCount
        ),
        created_at: createdAt,
        updated_at: updatedAt,
        is_edited: isEdited,
        is_owner:
          Boolean(viewerId) &&
          String(echo.user_id) ===
            String(viewerId),
        is_echo: true,
        echo_id: echo.id,
        echo_version:
          echo.echo_version ||
          'legacy',
        reader_post_id:
          linkedPost?.id ||
          echo.reader_post_id ||
          null,
        echo_type: echo.source_type,
        echo_destination:
          echo.destination || 'feed',
        echo_audience:
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
        source_type: echo.source_type,
        source_id: echo.source_id,
        source_url: source.url,
        source,
        source_story: sourceStory,
        source_episode: sourceEpisode,
        source_reader_post:
          sourceReaderPost,
        source_author_post:
          sourceAuthorPost,
        source_promotion:
          sourcePromotion,
                user: normalizeUser({
          ...user,
          is_following:
            relationships.viewerFollowsOwners.has(String(echo.user_id)),
        }),
      }
    })
    .filter(Boolean)
}

async function updateLinkedEchoFromPost(
  linkedEcho,
  userId,
  postId,
  content,
  updatedAt
) {
  if (!linkedEcho) return

  if (linkedEcho.echo_version === 'v2') {
    const { error } = await supabase
      .from('social_echoes_v2')
      .update({
        echo_text: content,
        updated_at: updatedAt,
      })
      .eq('id', linkedEcho.id)
      .eq('user_id', userId)

    if (error) throw error

    const { error: linkError } =
      await supabase
        .from(
          'social_echo_reader_posts_v2'
        )
        .update({
          updated_at: updatedAt,
        })
        .eq('echo_id', linkedEcho.id)
        .eq('reader_post_id', postId)
        .eq('user_id', userId)

    if (linkError) throw linkError
    return
  }

  const { error } = await supabase
    .from('social_echoes')
    .update({
      echo_text: content,
      updated_at: updatedAt,
    })
    .eq('id', linkedEcho.id)
    .eq('user_id', userId)
    .eq('reader_post_id', postId)

  if (error) throw error
}

async function deleteLinkedEchoFromPost(
  linkedEcho,
  userId,
  postId
) {
  if (!linkedEcho) return

  if (linkedEcho.echo_version === 'v2') {
    const { error } = await supabase
      .from('social_echoes_v2')
      .delete()
      .eq('id', linkedEcho.id)
      .eq('user_id', userId)

    if (error) throw error
    return
  }

  const { error } = await supabase
    .from('social_echoes')
    .delete()
    .eq('id', linkedEcho.id)
    .eq('user_id', userId)
    .eq('reader_post_id', postId)

  if (error) throw error
}

async function readOwnedPost(
  postId,
  userId
) {
  const { data, error } = await supabase
    .from('reader_posts')
    .select('*')
    .eq('id', postId)
    .eq('user_id', userId)
    .is('deleted_at', null)
    .maybeSingle()

  if (error) throw error

  return data
}

export async function getReaderPostById(
  req,
  res
) {
  try {
    const viewerId = getUserId(req)
    const postId = String(
      req.params.postId || ''
    ).trim()

    if (!postId) {
      return res.status(400).json({
        ok: false,
        message: 'Post ID is required',
      })
    }

    const syntheticMatch = postId.match(
      /^(echo-v2|social-echo):(.+)$/
    )

    if (syntheticMatch) {
      const echoVersion =
        syntheticMatch[1] === 'echo-v2'
          ? 'v2'
          : 'legacy'
      const echoId =
        syntheticMatch[2]

      const posts =
        await readSocialEchoPosts({
          viewerId,
          echoId,
          echoVersion,
          limit: 1,
        })

      const post = posts.find(
        (item) =>
          String(item?.echo_id || '') ===
          String(echoId)
      )

      if (!post) {
        return res.status(404).json({
          ok: false,
          message: 'Post not found',
        })
      }

      return res.status(200).json({
        ok: true,
        post,
      })
    }

    const { data, error } = await supabase
      .from('reader_posts')
      .select('*')
      .eq('id', postId)
      .is('deleted_at', null)
      .maybeSingle()

    if (error) throw error

    if (!data) {
      return res.status(404).json({
        ok: false,
        message: 'Post not found',
      })
    }

    const isOwner =
      Boolean(viewerId) &&
      String(data.user_id) ===
        String(viewerId)
    const publishTime = new Date(
      data.publish_at ||
        data.created_at ||
        0
    ).getTime()

    if (
      !isOwner &&
      publishTime &&
      publishTime > Date.now()
    ) {
      return res.status(404).json({
        ok: false,
        message: 'Post not found',
      })
    }

    const linkedEcho =
      await readLinkedEchoByPostId(
        data.id,
        data.user_id
      )

    if (linkedEcho?.id) {
      const posts =
        await readSocialEchoPosts({
          viewerId,
          echoId: String(linkedEcho.id),
          echoVersion:
            linkedEcho.echo_version ||
            'legacy',
          limit: 1,
        })

      const post = posts.find(
        (item) =>
          String(item?.echo_id || '') ===
          String(linkedEcho.id)
      )

      if (!post) {
        return res.status(404).json({
          ok: false,
          message: 'Post not found',
        })
      }

      return res.status(200).json({
        ok: true,
        post,
      })
    }

    const posts =
      await attachVisibleUsers(
        [data],
        viewerId
      )
    const post = posts[0] || null

    if (!post) {
      return res.status(404).json({
        ok: false,
        message: 'Post not found',
      })
    }

    return res.status(200).json({
      ok: true,
      post,
    })
  } catch (error) {
    console.error(
      'GET READER POST BY ID ERROR:',
      error
    )

    return res.status(500).json({
      ok: false,
      message:
        error.message ||
        'Failed to load reader post',
    })
  }
}

export async function getReaderPostsFeed(
  req,
  res
) {
  try {
    const viewerId = getUserId(req)
    const limit = getLimit(
      req.query.limit
    )

    const { data, error } = await supabase
      .from('reader_posts')
      .select('*')
      .is('deleted_at', null)
      .lte(
        'publish_at',
        new Date().toISOString()
      )
      .order('publish_at', {
        ascending: false,
      })
      .order('created_at', {
        ascending: false,
      })
      .limit(FEED_SCAN_LIMIT)

    if (error) throw error

    const [
      readerPosts,
      echoPosts,
      linkedEchoPostIds,
    ] = await Promise.all([
      attachVisibleUsers(
        data,
        viewerId
      ),
      readSocialEchoPosts({
        viewerId,
        feedOnly: true,
        limit: FEED_SCAN_LIMIT,
      }),
      readLinkedEchoPostIds(
        data.map((post) => post.id)
      ),
    ])
    const standardPosts =
      readerPosts.filter(
        (post) =>
          !linkedEchoPostIds.has(
            String(post.id)
          )
      )

    const posts = mergeTimelinePosts(
      [standardPosts, echoPosts],
      limit
    )

    return res.status(200).json({
      ok: true,
      posts,
      total: posts.length,
    })
  } catch (error) {
    console.error(
      'GET READER POSTS FEED ERROR:',
      error
    )

    return res.status(500).json({
      ok: false,
      message:
        error.message ||
        'Failed to load reader posts',
    })
  }
}

export async function getMyReaderPosts(
  req,
  res
) {
  try {
    const userId = getUserId(req)
    const limit = getLimit(
      req.query.limit
    )

    const { data, error } = await supabase
      .from('reader_posts')
      .select('*')
      .eq('user_id', userId)
      .is('deleted_at', null)
      .order('publish_at', {
        ascending: false,
      })
      .order('created_at', {
        ascending: false,
      })
      .limit(FEED_SCAN_LIMIT)

    if (error) throw error

    const [
      readerPosts,
      echoPosts,
      linkedEchoPostIds,
    ] = await Promise.all([
      attachVisibleUsers(
        data,
        userId
      ),
      readSocialEchoPosts({
        viewerId: userId,
        ownerId: userId,
        limit: FEED_SCAN_LIMIT,
      }),
      readLinkedEchoPostIds(
        data.map((post) => post.id)
      ),
    ])
    const standardPosts =
      readerPosts.filter(
        (post) =>
          !linkedEchoPostIds.has(
            String(post.id)
          )
      )

    const posts = mergeTimelinePosts(
      [standardPosts, echoPosts],
      limit
    )

    return res.status(200).json({
      ok: true,
      posts,
      total: posts.length,
    })
  } catch (error) {
    console.error(
      'GET MY READER POSTS ERROR:',
      error
    )

    return res.status(500).json({
      ok: false,
      message:
        error.message ||
        'Failed to load your posts',
    })
  }
}

export async function getReaderPostsByUsername(
  req,
  res
) {
  try {
    const viewerId = getUserId(req)
    const username =
      normalizeUsername(
        req.params.username
      )
    const limit = getLimit(
      req.query.limit
    )

    if (!username) {
      return res.status(400).json({
        ok: false,
        message:
          'Username is required',
      })
    }

    const {
      data: user,
      error: userError,
    } = await supabase
      .from('users')
      .select(
        'id, name, username, avatar_url, is_active'
      )
      .ilike(
        'username',
        escapeLikePattern(username)
      )
      .eq('is_active', true)
      .maybeSingle()

    if (userError) throw userError

    if (!user) {
      return res.status(404).json({
        ok: false,
        message:
          'Reader not found',
      })
    }

    const { data, error } =
      await supabase
        .from('reader_posts')
        .select('*')
        .eq('user_id', user.id)
        .is('deleted_at', null)
        .lte(
          'publish_at',
          new Date().toISOString()
        )
        .order('publish_at', {
          ascending: false,
        })
        .order('created_at', {
          ascending: false,
        })
        .limit(FEED_SCAN_LIMIT)

    if (error) throw error

    const [
      readerPosts,
      echoPosts,
      linkedEchoPostIds,
    ] = await Promise.all([
      attachVisibleUsers(
        data,
        viewerId
      ),
      readSocialEchoPosts({
        viewerId,
        ownerId: user.id,
        limit: FEED_SCAN_LIMIT,
      }),
      readLinkedEchoPostIds(
        data.map((post) => post.id)
      ),
    ])
    const standardPosts =
      readerPosts.filter(
        (post) =>
          !linkedEchoPostIds.has(
            String(post.id)
          )
      )

    const posts = mergeTimelinePosts(
      [standardPosts, echoPosts],
      limit
    )

    return res.status(200).json({
      ok: true,
      posts,
      total: posts.length,
      user: normalizeUser(user),
    })
  } catch (error) {
    console.error(
      'GET READER PROFILE POSTS ERROR:',
      error
    )

    return res.status(500).json({
      ok: false,
      message:
        error.message ||
        'Failed to load reader posts',
    })
  }
}

export async function createMyReaderPost(
  req,
  res
) {
  try {
    const userId = getUserId(req)
    const imageUrls =
  normalizeImageUrls(
    req.body.image_urls
  )

const photoMetadata =
  normalizePhotoMetadata(
    req.body.photo_metadata,
    imageUrls
  )

const content = validateContent(
      req.body.content,
      imageUrls
    )
    const visibility =
      normalizeVisibility(
        req.body.visibility,
        'public'
      )
    const commentsPermission =
      normalizeCommentsPermission(
        req.body.comments_permission,
        'everyone'
      )
    const storySharing = Boolean(
      req.body.story_sharing
    )
    const publishAt =
      normalizePublishAt(
        req.body.publish_at
      )

    const { data, error } =
      await supabase
        .from('reader_posts')
        .insert({
          user_id: userId,
          content,
          image_urls: imageUrls,
          photo_metadata:
            photoMetadata,
          visibility,
          comments_permission:
            commentsPermission,
          story_sharing:
            storySharing,
          publish_at: publishAt,
          updated_at:
            new Date().toISOString(),
        })
        .select('*')
        .single()

    if (error) throw error

    const userMap =
      await readUsersByIds([userId])
    const user = userMap.get(
      String(userId)
    )

    return res.status(201).json({
      ok: true,
      post: user
        ? normalizePost(
            data,
            user,
            userId
          )
        : null,
    })
  } catch (error) {
    console.error(
      'CREATE READER POST ERROR:',
      error
    )

    return res
      .status(
        error.statusCode || 500
      )
      .json({
        ok: false,
        message:
          error.message ||
          'Failed to create post',
      })
  }
}

export async function updateMyReaderPost(
  req,
  res
) {
  try {
    const userId = getUserId(req)
    const postId = String(
      req.params.postId || ''
    ).trim()

    const current =
      await readOwnedPost(
        postId,
        userId
      )

    if (!current) {
      return res.status(404).json({
        ok: false,
        message: 'Post not found',
      })
    }

    const linkedEcho =
      await readLinkedEchoByPostId(
        postId,
        userId
      )

    const imageUrls =
      req.body.image_urls === undefined
        ? Array.isArray(
            current.image_urls
          )
          ? current.image_urls
          : []
        : normalizeImageUrls(
            req.body.image_urls
          )

    const photoMetadata =
  normalizePhotoMetadata(
    req.body.photo_metadata,
    imageUrls,
    current.photo_metadata
  )

    const content = validateContent(
      req.body.content === undefined
        ? current.content
        : req.body.content,
      imageUrls,
      Boolean(linkedEcho)
    )

    const visibility =
      req.body.visibility === undefined
        ? current.visibility
        : normalizeVisibility(
            req.body.visibility,
            current.visibility
          )

    const commentsPermission =
      req.body
        .comments_permission ===
      undefined
        ? current.comments_permission
        : normalizeCommentsPermission(
            req.body
              .comments_permission,
            current.comments_permission
          )

    const storySharing =
      req.body.story_sharing ===
      undefined
        ? Boolean(
            current.story_sharing
          )
        : Boolean(
            req.body.story_sharing
          )

    const updatedAt =
      new Date().toISOString()
    const { data, error } =
      await supabase
        .from('reader_posts')
        .update({
          content,
          image_urls: imageUrls,
          photo_metadata:
            photoMetadata,
          visibility,
          comments_permission:
            commentsPermission,
          story_sharing:
            storySharing,
          updated_at: updatedAt,
        })
        .eq('id', postId)
        .eq('user_id', userId)
        .is('deleted_at', null)
        .select('*')
        .single()

    if (error) throw error

    await updateLinkedEchoFromPost(
      linkedEcho,
      userId,
      postId,
      content,
      updatedAt
    )

    const userMap =
      await readUsersByIds([userId])
    const user = userMap.get(
      String(userId)
    )

    return res.status(200).json({
      ok: true,
      post: user
        ? normalizePost(
            data,
            user,
            userId
          )
        : null,
    })
  } catch (error) {
    console.error(
      'UPDATE READER POST ERROR:',
      error
    )

    return res
      .status(
        error.statusCode || 500
      )
      .json({
        ok: false,
        message:
          error.message ||
          'Failed to update post',
      })
  }
}

export async function deleteMyReaderPost(
  req,
  res
) {
  try {
    const userId = getUserId(req)
    const postId = String(
      req.params.postId || ''
    ).trim()

    const current =
      await readOwnedPost(
        postId,
        userId
      )

    if (!current) {
      return res.status(404).json({
        ok: false,
        message: 'Post not found',
      })
    }

    const linkedEcho =
      await readLinkedEchoByPostId(
        postId,
        userId
      )

    const deletedAt =
      new Date().toISOString()

    const { error } = await supabase
      .from('reader_posts')
      .update({
        deleted_at: deletedAt,
        updated_at: deletedAt,
      })
      .eq('id', postId)
      .eq('user_id', userId)
      .is('deleted_at', null)

    if (error) throw error

    await deleteLinkedEchoFromPost(
      linkedEcho,
      userId,
      postId
    )

    return res.status(200).json({
      ok: true,
      deleted_id: postId,
      deleted_echo_id:
        linkedEcho?.id || null,
    })
  } catch (error) {
    console.error(
      'DELETE READER POST ERROR:',
      error
    )

    return res.status(500).json({
      ok: false,
      message:
        error.message ||
        'Failed to delete post',
    })
  }
}
