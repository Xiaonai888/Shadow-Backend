import { supabase } from '../config/supabase.js'

const MAX_POST_LENGTH = 1000
const DEFAULT_LIMIT = 20
const MAX_LIMIT = 30

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

  if (!Number.isFinite(parsed)) return DEFAULT_LIMIT

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
    const error = new Error('Post text is required')
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

function normalizeUser(user) {
  if (!user) return null

  return {
    id: user.id,
    name: user.name || 'Reader',
    username: user.username || '',
    avatar_url: user.avatar_url || null,
  }
}

function normalizePost(post, user, viewerId) {
  return {
    id: post.id,
    user_id: post.user_id,
    content: post.content || '',
    visibility: post.visibility || 'public',
    like_count: Number(post.like_count || 0),
    comment_count: Number(post.comment_count || 0),
    echo_count: Number(post.echo_count || 0),
    created_at: post.created_at,
    updated_at: post.updated_at,
    is_edited:
      Boolean(post.updated_at) &&
      Boolean(post.created_at) &&
      new Date(post.updated_at).getTime() >
        new Date(post.created_at).getTime() + 1000,
    is_owner:
      Boolean(viewerId) &&
      String(post.user_id) === String(viewerId),
    user: normalizeUser(user),
  }
}

async function attachUsers(posts, viewerId) {
  const rows = Array.isArray(posts) ? posts : []
  const userIds = [
    ...new Set(
      rows
        .map((post) => post?.user_id)
        .filter(Boolean)
    ),
  ]

  if (!userIds.length) return []

  const { data: users, error } = await supabase
    .from('users')
    .select('id, name, username, avatar_url, is_active')
    .in('id', userIds)

  if (error) throw error

  const userMap = new Map(
    (users || [])
      .filter((user) => user.is_active !== false)
      .map((user) => [String(user.id), user])
  )

  return rows
    .map((post) => {
      const user = userMap.get(
        String(post.user_id)
      )

      return user
        ? normalizePost(post, user, viewerId)
        : null
    })
    .filter(Boolean)
}

async function readOwnedPost(postId, userId) {
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

export async function getReaderPostsFeed(req, res) {
  try {
    const viewerId = getUserId(req)
    const limit = getLimit(req.query.limit)

    const { data, error } = await supabase
      .from('reader_posts')
      .select('*')
      .eq('visibility', 'public')
      .is('deleted_at', null)
      .order('created_at', {
        ascending: false,
      })
      .limit(limit)

    if (error) throw error

    const posts = await attachUsers(
      data,
      viewerId
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

export async function getMyReaderPosts(req, res) {
  try {
    const userId = getUserId(req)
    const limit = getLimit(req.query.limit)

    const { data, error } = await supabase
      .from('reader_posts')
      .select('*')
      .eq('user_id', userId)
      .is('deleted_at', null)
      .order('created_at', {
        ascending: false,
      })
      .limit(limit)

    if (error) throw error

    const posts = await attachUsers(
      data,
      userId
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
    const username = normalizeUsername(
      req.params.username
    )
    const limit = getLimit(req.query.limit)

    if (!username) {
      return res.status(400).json({
        ok: false,
        message: 'Username is required',
      })
    }

    const { data: user, error: userError } =
      await supabase
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
        message: 'Reader not found',
      })
    }

    const isOwner =
      String(user.id) === String(viewerId)

    let query = supabase
      .from('reader_posts')
      .select('*')
      .eq('user_id', user.id)
      .is('deleted_at', null)
      .order('created_at', {
        ascending: false,
      })
      .limit(limit)

    if (!isOwner) {
      query = query.eq(
        'visibility',
        'public'
      )
    }

    const { data, error } = await query

    if (error) throw error

    const posts = (data || []).map((post) =>
      normalizePost(post, user, viewerId)
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

    const { data, error } = await supabase
      .from('reader_posts')
      .insert({
        user_id: userId,
        content,
        visibility: 'public',
        updated_at:
          new Date().toISOString(),
      })
      .select('*')
      .single()

    if (error) throw error

    const posts = await attachUsers(
      [data],
      userId
    )

    return res.status(201).json({
      ok: true,
      post: posts[0] || null,
    })
  } catch (error) {
    console.error(
      'CREATE READER POST ERROR:',
      error
    )

    return res
      .status(error.statusCode || 500)
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
    const content = validateContent(
      req.body.content
    )

    const current = await readOwnedPost(
      postId,
      userId
    )

    if (!current) {
      return res.status(404).json({
        ok: false,
        message: 'Post not found',
      })
    }

    const { data, error } = await supabase
      .from('reader_posts')
      .update({
        content,
        updated_at:
          new Date().toISOString(),
      })
      .eq('id', postId)
      .eq('user_id', userId)
      .is('deleted_at', null)
      .select('*')
      .single()

    if (error) throw error

    const posts = await attachUsers(
      [data],
      userId
    )

    return res.status(200).json({
      ok: true,
      post: posts[0] || null,
    })
  } catch (error) {
    console.error(
      'UPDATE READER POST ERROR:',
      error
    )

    return res
      .status(error.statusCode || 500)
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

    const current = await readOwnedPost(
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
