import { supabase } from '../config/supabase.js'

function makeSlug(text) {
  return String(text || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function publicAuthorPage(page) {
  if (!page) return null

  return {
    id: page.id,
    user_id: page.user_id,
    page_name: page.page_name,
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

async function createUniqueSlug(pageName) {
  const baseSlug = makeSlug(pageName)

  if (!baseSlug) {
    return ''
  }

  let slug = baseSlug
  let count = 1

  while (true) {
    const { data, error } = await supabase
      .from('author_pages')
      .select('id')
      .eq('page_slug', slug)
      .maybeSingle()

    if (error) throw error

    if (!data) return slug

    count += 1
    slug = `${baseSlug}-${count}`
  }
}

export async function getMyAuthorPage(req, res) {
  try {
    const userId = req.user?.user_id

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
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

    return res.status(500).json({
      ok: false,
      message: 'Failed to fetch author page',
      error: error.message,
    })
  }
}

export async function createAuthorPage(req, res) {
  try {
    const userId = req.user?.user_id

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    const pageName = String(req.body.page_name || req.body.pageName || '').trim()
    const bio = String(req.body.bio || '').trim() || null

    if (!pageName) {
      return res.status(400).json({
        ok: false,
        message: 'Author name is required',
      })
    }

    if (pageName.length < 2) {
      return res.status(400).json({
        ok: false,
        message: 'Author name must be at least 2 characters',
      })
    }

    const { data: existingPage, error: existingError } = await supabase
      .from('author_pages')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle()

    if (existingError) throw existingError

    if (existingPage) {
      return res.status(200).json({
        ok: true,
        message: 'Author page already exists',
        author_page: publicAuthorPage(existingPage),
      })
    }

    const pageSlug = await createUniqueSlug(pageName)

    if (!pageSlug) {
      return res.status(400).json({
        ok: false,
        message: 'Author name cannot create a valid slug',
      })
    }

    const { data: createdPage, error: createError } = await supabase
      .from('author_pages')
      .insert({
        user_id: userId,
        page_name: pageName,
        page_slug: pageSlug,
        bio,
        status: 'active',
        updated_at: new Date().toISOString(),
      })
      .select()
      .single()

    if (createError) throw createError

    const { error: userUpdateError } = await supabase
      .from('users')
      .update({
        is_author: true,
        updated_at: new Date().toISOString(),
      })
      .eq('id', userId)

    if (userUpdateError) throw userUpdateError

    return res.status(201).json({
      ok: true,
      message: 'Author page created successfully',
      author_page: publicAuthorPage(createdPage),
    })
  } catch (error) {
    console.error('CREATE AUTHOR PAGE ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to create author page',
      error: error.message,
    })
  }
}
