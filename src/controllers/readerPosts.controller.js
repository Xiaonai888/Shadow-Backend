import { supabase } from '../config/supabase.js'

const MAX_POST_LENGTH = 10000
const MAX_POST_IMAGES = 5
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

function validateContent(
  value,
  imageUrls = []
) {
  const content = normalizeContent(value)

  if (
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
  }
}

function normalizePost(
  post,
  user,
  viewerId
) {
  return {
    id: post.id,
    user_id: post.user_id,
    content: post.content || '',
    image_urls: Array.isArray(
      post.image_urls
    )
      ? post.image_urls
          .filter(
            (url) =>
              typeof url === 'string' &&
              url.trim()
          )
          .slice(0, MAX_POST_IMAGES)
      : [],
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

  const [userMap, relationships] =
    await Promise.all([
      readUsersByIds(ownerIds),
      getRelationshipMaps(
        viewerId,
        ownerIds
      ),
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

      return user
        ? normalizePost(
            post,
            user,
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

function mergeTimelinePosts(
  groups,
  limit
) {
  return groups
    .flat()
    .filter(Boolean)
    .sort((left, right) => {
      const rightTime = new Date(
        right.publish_at ||
          right.created_at ||
          0
      ).getTime()
      const leftTime = new Date(
        left.publish_at ||
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
    .slice(0, limit)
}

async function readEpisodeEchoPosts({
  viewerId,
  ownerId = '',
  publicFeed = false,
  limit = FEED_SCAN_LIMIT,
}) {
  let query = supabase
    .from('episode_echoes')
    .select(
      'id, episode_id, story_id, user_id, echo_text, destination, audience, created_at'
    )
    .order('created_at', {
      ascending: false,
    })
    .limit(limit)

  if (publicFeed) {
    query = query
      .eq('destination', 'feed')
      .eq('audience', 'public')
  } else {
    query = query.in(
      'destination',
      ['feed', 'shadow']
    )
  }

  if (ownerId) {
    query = query.eq(
      'user_id',
      ownerId
    )

    if (
      String(ownerId) !==
      String(viewerId)
    ) {
      query = query.eq(
        'audience',
        'public'
      )
    }
  }

  const {
    data: echoes,
    error: echoError,
  } = await query

  if (echoError) throw echoError

  const rows = Array.isArray(echoes)
    ? echoes
    : []

  if (!rows.length) return []

  const userIds = [
    ...new Set(
      rows
        .map((item) =>
          String(item.user_id || '')
        )
        .filter(Boolean)
    ),
  ]
  const episodeIds = [
    ...new Set(
      rows
        .map((item) =>
          String(item.episode_id || '')
        )
        .filter(Boolean)
    ),
  ]
  const storyIds = [
    ...new Set(
      rows
        .map((item) =>
          String(item.story_id || '')
        )
        .filter(Boolean)
    ),
  ]

  const userMap =
    await readUsersByIds(userIds)

  let episodes = []
  let stories = []

  if (episodeIds.length) {
    const {
      data,
      error,
    } = await supabase
      .from('episodes')
      .select(
        'id, story_id, title, episode_number, cover_url, status, deleted_at'
      )
      .in('id', episodeIds)
      .is('deleted_at', null)

    if (error) throw error
    episodes = data || []
  }

  if (storyIds.length) {
    const {
      data,
      error,
    } = await supabase
      .from('stories')
      .select(
        'id, title, cover_url, landscape_thumbnail_url, main_genre, status, deleted_at'
      )
      .in('id', storyIds)
      .is('deleted_at', null)

    if (error) throw error
    stories = data || []
  }

  const episodeMap = new Map(
    episodes.map((episode) => [
      String(episode.id),
      episode,
    ])
  )
  const storyMap = new Map(
    stories.map((story) => [
      String(story.id),
      story,
    ])
  )

  return rows
    .map((echo) => {
      const user = userMap.get(
        String(echo.user_id)
      )
      const episode = episodeMap.get(
        String(echo.episode_id)
      )
      const story = storyMap.get(
        String(echo.story_id)
      )

      if (!user || !episode || !story) {
        return null
      }

      if (
        String(episode.status || '')
          .toLowerCase() !==
          'published' ||
        String(story.status || '')
          .toLowerCase() !==
          'published'
      ) {
        return null
      }

      const sourceImage =
        story.landscape_thumbnail_url ||
        story.cover_url ||
        episode.cover_url ||
        ''
      const sourceTitle =
        story.title || 'Story'
      const episodeTitle =
        episode.title ||
        `Episode ${Number(
          episode.episode_number || 0
        )}`
      const echoText = String(
        echo.echo_text || ''
      ).trim()

      return {
        id: `episode-echo:${echo.id}`,
        user_id: echo.user_id,
        content:
          echoText ||
          `Echoed “${sourceTitle}” — ${episodeTitle}`,
        image_urls: sourceImage
          ? [sourceImage]
          : [],
        visibility:
          echoAudienceToVisibility(
            echo.audience
          ),
        comments_permission:
          'no_one',
        story_sharing: true,
        publish_at:
          echo.created_at,
        like_count: 0,
        comment_count: 0,
        echo_count: 0,
        created_at:
          echo.created_at,
        updated_at:
          echo.created_at,
        is_edited: false,
        is_owner: false,
        is_echo: true,
        echo_id: echo.id,
        echo_type:
          'episode',
        echo_destination:
          echo.destination ||
          'feed',
        echo_audience:
          echo.audience ||
          'public',
        source_type:
          'episode',
        source_id:
          episode.id,
        source_url:
          `/story/${story.id}/episode/${episode.id}`,
        source_story: {
          id: story.id,
          title: sourceTitle,
          cover_url:
            story.cover_url || '',
          landscape_thumbnail_url:
            story.landscape_thumbnail_url ||
            '',
          main_genre:
            story.main_genre || '',
        },
        source_episode: {
          id: episode.id,
          title: episodeTitle,
          episode_number: Number(
            episode.episode_number || 0
          ),
          cover_url:
            episode.cover_url || '',
        },
        user: normalizeUser(user),
      }
    })
    .filter(Boolean)
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
    ] = await Promise.all([
      attachVisibleUsers(
        data,
        viewerId
      ),
      readEpisodeEchoPosts({
        viewerId,
        publicFeed: true,
        limit: FEED_SCAN_LIMIT,
      }),
    ])

    const posts = mergeTimelinePosts(
      [readerPosts, echoPosts],
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
      .limit(limit)

    if (error) throw error

    const userMap =
      await readUsersByIds([userId])
    const user = userMap.get(
      String(userId)
    )

    const readerPosts = (data || [])
      .map((post) =>
        user
          ? normalizePost(
              post,
              user,
              userId
            )
          : null
      )
      .filter(Boolean)

    const echoPosts =
      await readEpisodeEchoPosts({
        viewerId: userId,
        ownerId: userId,
        limit: FEED_SCAN_LIMIT,
      })

    const posts = mergeTimelinePosts(
      [readerPosts, echoPosts],
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
      .ilike('username', escapeLikePattern(username))
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

    const relationships =
      await getRelationshipMaps(
        viewerId,
        [user.id]
      )

    const readerPosts = (data || [])
      .filter((post) =>
        canViewerSeePost(
          post,
          viewerId,
          relationships
        )
      )
      .map((post) =>
        normalizePost(
          post,
          user,
          viewerId
        )
      )

    const echoPosts =
      await readEpisodeEchoPosts({
        viewerId,
        ownerId: user.id,
        limit: FEED_SCAN_LIMIT,
      })

    const posts = mergeTimelinePosts(
      [readerPosts, echoPosts],
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

    const content = validateContent(
      req.body.content === undefined
        ? current.content
        : req.body.content,
      imageUrls
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

    const { data, error } =
      await supabase
        .from('reader_posts')
        .update({
          content,
          image_urls: imageUrls,
          visibility,
          comments_permission:
            commentsPermission,
          story_sharing:
            storySharing,
          updated_at:
            new Date().toISOString(),
        })
        .eq('id', postId)
        .eq('user_id', userId)
        .is('deleted_at', null)
        .select('*')
        .single()

    if (error) throw error

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

    return res.status(200).json({
      ok: true,
      deleted_id: postId,
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
