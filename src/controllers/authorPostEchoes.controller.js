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
    selected_reader_ids:
      Array.isArray(
        item.selected_reader_ids
      )
        ? item.selected_reader_ids
        : [],
    created_at: item.created_at,
    user: publicUser(
      item.user,
      item.user_id
    ),
  }
}

async function readPost(postId) {
  const { data, error } = await supabase
    .from('author_page_posts')
    .select(
      'id, author_page_id, user_id, content, image_urls, status, echo_count, author_page:author_pages(id, user_id, page_name, page_username, avatar_url)'
    )
    .eq('id', postId)
    .eq('status', 'active')
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

async function readEchoCount(postId) {
  const { count, error } = await supabase
    .from('author_page_post_echoes')
    .select('id', {
      count: 'exact',
      head: true,
    })
    .eq('post_id', postId)

  if (error) throw error

  return Number(count || 0)
}

export async function getAuthorPostEchoes(
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

    if (!post) {
      return res.status(404).json({
        ok: false,
        message: 'Author post not found',
      })
    }

    const { data, error, count } =
      await supabase
        .from('author_page_post_echoes')
        .select(
          'id, post_id, user_id, echo_text, destination, audience, selected_reader_ids, created_at, user:users(id, name, username, avatar_url)',
          { count: 'exact' }
        )
        .eq('post_id', postId)
        .or(
          `audience.eq.public,user_id.eq.${viewerId}`
        )
        .order('created_at', {
          ascending: false,
        })
        .range(from, to)

    if (error) throw error

    const total = Number(count || 0)
    const authorPage = Array.isArray(
      post.author_page
    )
      ? post.author_page[0]
      : post.author_page

    return res.status(200).json({
      ok: true,
      post: {
        id: post.id,
        author_page_id:
          post.author_page_id,
        user_id: post.user_id,
        content: post.content || '',
        image_urls: Array.isArray(
          post.image_urls
        )
          ? post.image_urls
          : [],
        echo_count: Number(
          post.echo_count || 0
        ),
        author_page: authorPage || null,
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
      'GET AUTHOR POST ECHOES ERROR:',
      error
    )

    return res.status(500).json({
      ok: false,
      message:
        error.message ||
        'Failed to load author post echoes',
    })
  }
}

export async function createAuthorPostEcho(
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

    if (!post) {
      return res.status(404).json({
        ok: false,
        message: 'Author post not found',
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
    const selectedReaderIds =
      normalizeReaderIds(
        req.body?.selected_reader_ids
      )

    const { data, error } = await supabase
      .from('author_page_post_echoes')
      .insert({
        post_id: post.id,
        user_id: userId,
        echo_text: echoText,
        destination,
        audience,
        selected_reader_ids:
          selectedReaderIds,
      })
      .select(
        'id, post_id, user_id, echo_text, destination, audience, selected_reader_ids, created_at'
      )
      .single()

    if (error) throw error

    const echoCount = await readEchoCount(
      post.id
    )

    const { error: updateError } =
      await supabase
        .from('author_page_posts')
        .update({
          echo_count: echoCount,
          updated_at:
            new Date().toISOString(),
        })
        .eq('id', post.id)
        .eq('status', 'active')

    if (updateError) throw updateError

    const reader = await readUser(userId)

    return res.status(201).json({
      ok: true,
      echo_count: echoCount,
      echo: publicEcho({
        ...data,
        user: reader,
      }),
    })
  } catch (error) {
    console.error(
      'CREATE AUTHOR POST ECHO ERROR:',
      error
    )

    return res.status(500).json({
      ok: false,
      message:
        error.message ||
        'Failed to echo author post',
    })
  }
}
