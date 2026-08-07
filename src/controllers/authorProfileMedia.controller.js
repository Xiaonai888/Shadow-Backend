import { supabase } from '../config/supabase.js'
import {
  assertR2MediaReference,
} from '../services/mediaStoragePolicy.service.js'

function clean(value) {
  return String(value ?? '').trim()
}

function publicAuthorPage(page) {
  if (!page) return null

  return {
    id: page.id,
    user_id: page.user_id,
    page_name: page.page_name,
    page_username: page.page_username,
    page_slug: page.page_slug,
    bio: page.bio,
    avatar_url: page.avatar_url,
    cover_url: page.cover_url,
    slide_urls: Array.isArray(page.slide_urls) ? page.slide_urls : [],
    profile_details: page.profile_details || {},
    status: page.status,
    total_stories: page.total_stories,
    total_followers: page.total_followers,
    created_at: page.created_at,
    updated_at: page.updated_at,
  }
}

async function getCurrentAuthorPage(userId) {
  const { data, error } = await supabase
    .from('author_pages')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle()

  if (error) throw error

  if (!data) {
    const error = new Error('Author page not found')
    error.statusCode = 404
    error.code = 'AUTHOR_PAGE_NOT_FOUND'
    throw error
  }

  return data
}

function safeMediaReference(value, currentValue, field) {
  const input = clean(value)
  const current = clean(currentValue)

  if (input && input === current) {
    return input
  }

  return assertR2MediaReference(input, {
    field,
    allowEmpty: false,
  })
}

function safeSlideUrls(values, currentValues = []) {
  if (!Array.isArray(values)) return null

  const existing = new Set(
    (Array.isArray(currentValues) ? currentValues : [])
      .map(clean)
      .filter(Boolean)
  )

  return values
    .filter(Boolean)
    .map(clean)
    .filter(Boolean)
    .slice(0, 5)
    .map((value, index) => {
      if (existing.has(value)) return value

      return assertR2MediaReference(value, {
        field: `author_pages.slide_urls[${index}]`,
        allowEmpty: false,
      })
    })
}

function sendError(res, error, fallback) {
  const status = Number(error?.statusCode || 500)

  if (status >= 400 && status < 500) {
    return res.status(status).json({
      ok: false,
      code: error?.code || 'INVALID_REQUEST',
      message: error?.message || fallback,
    })
  }

  return res.status(500).json({
    ok: false,
    message: fallback,
    error: error?.message || '',
  })
}

export async function updateAuthorAvatar(req, res) {
  try {
    const userId = req.user?.user_id

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    const avatarUrl = clean(
      req.body.avatar_url || req.body.avatarUrl
    )

    if (!avatarUrl) {
      return res.status(400).json({
        ok: false,
        message: 'Avatar URL is required',
      })
    }

    const currentPage = await getCurrentAuthorPage(userId)
    const safeAvatarUrl = safeMediaReference(
      avatarUrl,
      currentPage.avatar_url,
      'author_pages.avatar_url'
    )

    const { data, error } = await supabase
      .from('author_pages')
      .update({
        avatar_url: safeAvatarUrl,
        updated_at: new Date().toISOString(),
      })
      .eq('user_id', userId)
      .select()
      .single()

    if (error) throw error

    return res.status(200).json({
      ok: true,
      message: 'Author profile photo updated',
      author_page: publicAuthorPage(data),
    })
  } catch (error) {
    console.error('UPDATE AUTHOR AVATAR ERROR:', error)
    return sendError(
      res,
      error,
      'Failed to update author profile photo'
    )
  }
}

export async function updateAuthorProfileImages(req, res) {
  try {
    const userId = req.user?.user_id

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    const avatarUrl = clean(
      req.body.avatar_url || req.body.avatarUrl
    )
    const coverUrl = clean(
      req.body.cover_url || req.body.coverUrl
    )
    const hasSlideUrls = Array.isArray(req.body.slide_urls)

    if (!avatarUrl && !coverUrl && !hasSlideUrls) {
      return res.status(400).json({
        ok: false,
        message: 'Avatar URL, cover URL, or slide URLs are required',
      })
    }

    const currentPage = await getCurrentAuthorPage(userId)
    const updates = {
      updated_at: new Date().toISOString(),
    }

    if (avatarUrl) {
      updates.avatar_url = safeMediaReference(
        avatarUrl,
        currentPage.avatar_url,
        'author_pages.avatar_url'
      )
    }

    if (coverUrl) {
      updates.cover_url = safeMediaReference(
        coverUrl,
        currentPage.cover_url,
        'author_pages.cover_url'
      )
    }

    if (hasSlideUrls) {
      updates.slide_urls = safeSlideUrls(
        req.body.slide_urls,
        currentPage.slide_urls
      )
    }

    const { data, error } = await supabase
      .from('author_pages')
      .update(updates)
      .eq('user_id', userId)
      .select()
      .single()

    if (error) throw error

    return res.status(200).json({
      ok: true,
      message: 'Author profile images updated',
      author_page: publicAuthorPage(data),
    })
  } catch (error) {
    console.error('UPDATE AUTHOR PROFILE IMAGES ERROR:', error)
    return sendError(
      res,
      error,
      'Failed to update author profile images'
    )
  }
}
