import { supabase } from '../config/supabase.js'

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
  const choice = String(
    value || fallback
  )
    .trim()
    .toLowerCase()

  return allowed.has(choice)
    ? choice
    : fallback
}

function normalizeVisibility(value) {
  return String(value || 'public')
    .trim()
    .toLowerCase()
}

function publicUser(user, fallbackId = null) {
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

function publicEcho(item) {
  return {
    id: item.id,
    post_id: item.post_id,
    user_id: item.user_id,
    echo_text: item.echo_text || '',
    destination:
      item.destination || 'feed',
    audience: item.audience || 'public',
    created_at: item.created_at,
    user: publicUser(
      item.user,
      item.user_id
    ),
  }
}

async function readPost(postId) {
  const { data, error } = await supabase
    .from('reader_posts')
    .select(
      'id, user_id, content, visibility, publish_at, echo_count, deleted_at'
    )
    .eq('id', postId)
    .is('deleted_at', null)
    .maybeSingle()

  if (error) throw error

  return data
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

  if (!data || data.is_active === false) {
    return null
  }

  return data
}

async function viewerFollows(
  followerId,
  followingId
) {
  const { data, error } = await supabase
    .from('user_follows')
    .select('follower_user_id')
    .eq('follower_user_id', followerId)
    .eq('following_user_id', followingId)
    .maybeSingle()

  if (error) throw error

  return Boolean(data)
}

async function canViewPost(
  post,
  viewerId
) {
  if (!post || !viewerId) return false

  const ownerId = String(
    post.user_id || ''
  )
  const currentViewerId = String(
    viewerId || ''
  )

  if (ownerId === currentViewerId) {
    return true
  }

  if (
    post.publish_at &&
    new Date(post.publish_at).getTime() >
      Date.now()
  ) {
    return false
  }

  const visibility = normalizeVisibility(
    post.visibility
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

async function readEchoCount(postId) {
  const { count, error } = await supabase
    .from('reader_post_echoes')
    .select('id', {
      count: 'exact',
      head: true,
    })
    .eq('post_id', postId)

  if (error) throw error

  return Number(count || 0)
}

export async function getReaderPostEchoes(
  req,
  res
) {
  try {
    const viewerId = getUserId(req)
    const postId = cleanText(
      req.params.postId,
      100
    )
    const page = Math.max(
      1,
      Number(req.query.page || 1)
    )
    const limit = Math.min(
      50,
      Math.max(
        1,
        Number(req.query.limit || 20)
      )
    )
    const from = (page - 1) * limit
    const to = from + limit - 1

    if (!viewerId) {
      return res.status(401).json({
        ok: false,
        message: 'Login is required',
      })
    }

    if (!postId) {
      return res.status(400).json({
        ok: false,
        message: 'Post ID is required',
      })
    }

    const post = await readPost(postId)

    if (
      !post ||
      !(await canViewPost(
        post,
        viewerId
      ))
    ) {
      return res.status(404).json({
        ok: false,
        message: 'Reader post not found',
      })
    }

    const sourceUser = await readUser(
      post.user_id
    )

    let query = supabase
      .from('reader_post_echoes')
      .select(
        'id, post_id, user_id, echo_text, destination, audience, created_at, user:users(id, name, username, avatar_url)',
        { count: 'exact' }
      )
      .eq('post_id', postId)
      .or(
        `audience.eq.public,user_id.eq.${viewerId}`
      )

    const { data, error, count } =
      await query
        .order('created_at', {
          ascending: false,
        })
        .range(from, to)

    if (error) throw error

    const total = Number(count || 0)

    return res.status(200).json({
      ok: true,
      post: {
        id: post.id,
        user_id: post.user_id,
        content: post.content || '',
        echo_count: Number(
          post.echo_count || 0
        ),
        user: publicUser(
          sourceUser,
          post.user_id
        ),
      },
      total,
      page,
      limit,
      has_more: to + 1 < total,
      echoes: (data || []).map(
        publicEcho
      ),
    })
  } catch (error) {
    console.error(
      'GET READER POST ECHOES ERROR:',
      error
    )

    return res.status(500).json({
      ok: false,
      message:
        error.message ||
        'Failed to load reader post echoes',
    })
  }
}

export async function createReaderPostEcho(
  req,
  res
) {
  try {
    const userId = getUserId(req)
    const postId = cleanText(
      req.params.postId,
      100
    )

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Login is required',
      })
    }

    if (!postId) {
      return res.status(400).json({
        ok: false,
        message: 'Post ID is required',
      })
    }

    const post = await readPost(postId)

    if (
      !post ||
      !(await canViewPost(post, userId))
    ) {
      return res.status(404).json({
        ok: false,
        message: 'Reader post not found',
      })
    }

    const echoText = cleanText(
      req.body?.echo_text,
      280
    )
    const destination = normalizeChoice(
      req.body?.destination,
      DESTINATIONS,
      'feed'
    )
    const audience = normalizeChoice(
      req.body?.audience,
      AUDIENCES,
      'public'
    )

    const { data, error } = await supabase
      .from('reader_post_echoes')
      .insert({
        post_id: post.id,
        user_id: userId,
        echo_text: echoText,
        destination,
        audience,
      })
      .select(
        'id, post_id, user_id, echo_text, destination, audience, created_at'
      )
      .single()

    if (error) throw error

    const echoCount = await readEchoCount(
      post.id
    )

    const { error: updateError } =
      await supabase
        .from('reader_posts')
        .update({
          echo_count: echoCount,
        })
        .eq('id', post.id)
        .is('deleted_at', null)

    if (updateError) throw updateError

    const reader = await readUser(userId)

    return res.status(201).json({
      ok: true,
      echo_count: echoCount,
      echo: {
        ...data,
        user: publicUser(
          reader,
          userId
        ),
      },
    })
  } catch (error) {
    console.error(
      'CREATE READER POST ECHO ERROR:',
      error
    )

    return res.status(500).json({
      ok: false,
      message:
        error.message ||
        'Failed to echo reader post',
    })
  }
}
