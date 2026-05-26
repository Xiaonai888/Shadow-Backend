import { supabase } from '../config/supabase.js'

function normalizePageUsername(username) {
  return String(username || '')
    .trim()
    .replace(/^@+/, '')
    .toLowerCase()
}

function isValidPageUsername(username) {
  return /^[a-z0-9_]+$/.test(username)
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
    status: page.status,
    total_stories: page.total_stories,
    total_followers: page.total_followers,
    created_at: page.created_at,
    updated_at: page.updated_at,
  }
}

export async function getMyAuthorPage(req, res) {
  try {
    const userId = req.user?.user_id

    if (!userId) {
      return res.status(401).json({ ok: false, message: 'Unauthorized' })
    }

    const { data, error } = await supabase
      .from('author_pages')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle()

    if (error) throw error

    return res.status(200).json({
      ok: true,
      has_author_page: Boolean(data),
      author_page: publicAuthorPage(data),
    })
  } catch (error) {
    console.error('GET MY AUTHOR PAGE ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to fetch author page', error: error.message })
  }
}

export async function getPublicAuthorPage(req, res) {
  try {
    const pageUsername = normalizePageUsername(req.params.pageUsername)

    if (!pageUsername) {
      return res.status(400).json({ ok: false, message: 'Page username is required' })
    }

    const { data, error } = await supabase
      .from('author_pages')
      .select('*')
      .eq('page_username', pageUsername)
      .eq('status', 'active')
      .maybeSingle()

    if (error) throw error

    if (!data) {
      return res.status(404).json({ ok: false, message: 'Author page not found' })
    }

    return res.status(200).json({
      ok: true,
      author_page: publicAuthorPage(data),
    })
  } catch (error) {
    console.error('GET PUBLIC AUTHOR PAGE ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to fetch author page', error: error.message })
  }
}

export async function createAuthorPage(req, res) {
  try {
    const userId = req.user?.user_id

    if (!userId) {
      return res.status(401).json({ ok: false, message: 'Unauthorized' })
    }

    const pageName = String(req.body.page_name || req.body.pageName || '').trim()
    const pageUsername = normalizePageUsername(req.body.page_username || req.body.pageUsername)
    const bio = String(req.body.bio || '').trim() || null

    if (!pageName || !pageUsername) {
      return res.status(400).json({ ok: false, message: 'Page name and page username are required' })
    }

    if (pageName.length < 2) {
      return res.status(400).json({ ok: false, message: 'Page name must be at least 2 characters' })
    }

    if (pageUsername.length < 3) {
      return res.status(400).json({ ok: false, message: 'Page username must be at least 3 characters' })
    }

    if (!isValidPageUsername(pageUsername)) {
      return res.status(400).json({ ok: false, message: 'Page username can only use letters, numbers, and underscore' })
    }

    const { data: existingPage, error: existingError } = await supabase
      .from('author_pages')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle()

    if (existingError) throw existingError

    if (existingPage) {
      return res.status(200).json({ ok: true, message: 'Author page already exists', author_page: publicAuthorPage(existingPage) })
    }

    const { data: usernameTaken, error: usernameError } = await supabase
      .from('author_pages')
      .select('id')
      .eq('page_username', pageUsername)
      .maybeSingle()

    if (usernameError) throw usernameError

    if (usernameTaken) {
      return res.status(409).json({ ok: false, message: 'Page username already exists' })
    }

    const { data: createdPage, error: createError } = await supabase
      .from('author_pages')
      .insert({
        user_id: userId,
        page_name: pageName,
        page_username: pageUsername,
        page_slug: pageUsername,
        bio,
        status: 'active',
        updated_at: new Date().toISOString(),
      })
      .select()
      .single()

    if (createError) throw createError

    const { error: userUpdateError } = await supabase
      .from('users')
      .update({ is_author: true, updated_at: new Date().toISOString() })
      .eq('id', userId)

    if (userUpdateError) throw userUpdateError

    return res.status(201).json({ ok: true, message: 'Author page created successfully', author_page: publicAuthorPage(createdPage) })
  } catch (error) {
    console.error('CREATE AUTHOR PAGE ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to create author page', error: error.message })
  }
}

export async function updateAuthorAvatar(req, res) {
  try {
    const userId = req.user?.user_id

    if (!userId) {
      return res.status(401).json({ ok: false, message: 'Unauthorized' })
    }

    const avatarUrl = String(req.body.avatar_url || req.body.avatarUrl || '').trim()

    if (!avatarUrl) {
      return res.status(400).json({ ok: false, message: 'Avatar URL is required' })
    }

    const { data, error } = await supabase
      .from('author_pages')
      .update({ avatar_url: avatarUrl, updated_at: new Date().toISOString() })
      .eq('user_id', userId)
      .select()
      .single()

    if (error) throw error

    return res.status(200).json({ ok: true, message: 'Author profile photo updated', author_page: publicAuthorPage(data) })
  } catch (error) {
    console.error('UPDATE AUTHOR AVATAR ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to update author profile photo', error: error.message })
  }
}

export async function updateAuthorProfileImages(req, res) {
  try {
    const userId = req.user?.user_id

    if (!userId) {
      return res.status(401).json({ ok: false, message: 'Unauthorized' })
    }

    const avatarUrl = String(req.body.avatar_url || req.body.avatarUrl || '').trim()
    const coverUrl = String(req.body.cover_url || req.body.coverUrl || '').trim()

    if (!avatarUrl && !coverUrl) {
      return res.status(400).json({ ok: false, message: 'Avatar URL or cover URL is required' })
    }

    const updates = {
      updated_at: new Date().toISOString(),
    }

    if (avatarUrl) updates.avatar_url = avatarUrl
    if (coverUrl) updates.cover_url = coverUrl

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
    return res.status(500).json({ ok: false, message: 'Failed to update author profile images', error: error.message })
  }
}
