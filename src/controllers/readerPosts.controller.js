import { supabase } from '../config/supabase.js'

const MAX_POST_LENGTH = 10000
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
    .toLowerCase()
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

function validateContent(value) {
  const content = normalizeContent(value)

  if (!content) {
    const error = new Error(
      'Post text is required'
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

    const posts = (
      await attachVisibleUsers(
        data,
        viewerId
      )
    ).slice(0, limit)

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

    const posts = (data || [])
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
      .eq('username', username)
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

    const posts = (data || [])
      .filter((post) =>
        canViewerSeePost(
          post,
          viewerId,
          relationships
        )
      )
      .slice(0, limit)
      .map((post) =>
        normalizePost(
          post,
          user,
          viewerId
        )
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
    const content = validateContent(
      req.body.content
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

    const content =
      req.body.content === undefined
        ? current.content
        : validateContent(
            req.body.content
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
