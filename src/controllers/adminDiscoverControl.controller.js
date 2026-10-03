import { supabase } from '../config/supabase.js'
import { verifyAdminPasskeyPin } from '../services/adminPasskeyPin.service.js'
import { invalidateDiscoverAuthorPostsSharedCache } from '../services/discoverAuthorPostsSharedCache.service.js'

const MAX_SELECTED = 10
const SEARCH_LIMIT = 20

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value || ''))
}

function cleanSearch(value) {
  return String(value || '').trim().slice(0, 64)
}

function cleanLike(value) {
  return String(value || '').replace(/[\\%_]/g, '\\$&')
}

function getAdminIdentity(admin = {}) {
  return {
    adminId: String(admin.admin_id || admin.id || '').trim(),
    adminEmail: String(admin.email || '').trim().toLowerCase(),
  }
}

async function latestPostsByAuthor(authorPageIds) {
  const ids = [...new Set((authorPageIds || []).filter(Boolean))]

  if (!ids.length) return new Map()

  const { data, error } = await supabase
    .from('author_page_posts')
    .select('id, author_page_id, created_at')
    .in('author_page_id', ids)
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(Math.min(ids.length * 20, 200))

  if (error) throw error

  const map = new Map()

  for (const post of data || []) {
    const authorPageId = String(post.author_page_id || '')
    if (!authorPageId || map.has(authorPageId)) continue
    map.set(authorPageId, post)
  }

  return map
}

function formatAuthor(page, latestPost = null) {
  return {
    id: page.id,
    author_page_id: page.id,
    page_name: page.page_name || 'Unnamed Author Page',
    page_username: page.page_username || '',
    avatar_url: page.avatar_url || '',
    total_followers: Number(page.total_followers || 0),
    newest_post_at: latestPost?.created_at || null,
    newest_post_id: latestPost?.id || null,
  }
}

async function verifyPasskey(req, purpose) {
  const pin = String(req.body?.passkey_pin || '').trim()

  if (!/^\d{6}$/.test(pin)) {
    return {
      ok: false,
      status: 400,
      body: {
        ok: false,
        code: 'PASSKEY_REQUIRED',
        message: '6-digit Passkey required',
      },
    }
  }

  const verification = await verifyAdminPasskeyPin({
    admin: req.admin,
    req,
    pin,
    purpose,
  })

  if (!verification.ok) {
    return {
      ok: false,
      status: verification.status || 403,
      body: {
        ok: false,
        code: verification.code || 'PASSKEY_INVALID',
        message: verification.message || 'Passkey verification failed',
        ...(verification.retry_after_seconds
          ? { retry_after_seconds: verification.retry_after_seconds }
          : {}),
      },
    }
  }

  return { ok: true }
}

export async function getDiscoverControlAuthors(req, res) {
  try {
    const { data: selectedRows, error: selectedError } = await supabase
      .from('admin_discover_control_authors')
      .select('author_page_id, created_at')
      .order('created_at', { ascending: false })
      .limit(MAX_SELECTED)

    if (selectedError) throw selectedError

    const ids = (selectedRows || [])
      .map(row => row.author_page_id)
      .filter(Boolean)

    if (!ids.length) {
      return res.status(200).json({
        ok: true,
        authors: [],
        max_selected: MAX_SELECTED,
      })
    }

    const [{ data: pages, error: pagesError }, latestMap] = await Promise.all([
      supabase
        .from('author_pages')
        .select('id, page_name, page_username, avatar_url, total_followers, status')
        .in('id', ids),
      latestPostsByAuthor(ids),
    ])

    if (pagesError) throw pagesError

    const authors = (pages || [])
      .filter(page => String(page.status || '').toLowerCase() === 'active')
      .map(page => formatAuthor(page, latestMap.get(String(page.id)) || null))
      .sort((first, second) => {
        const firstTime = new Date(first.newest_post_at || 0).getTime()
        const secondTime = new Date(second.newest_post_at || 0).getTime()
        return secondTime - firstTime
      })

    return res.status(200).json({
      ok: true,
      authors,
      max_selected: MAX_SELECTED,
    })
  } catch (error) {
    console.error('ADMIN DISCOVER CONTROL LIST ERROR:', error)
    return res.status(500).json({
      ok: false,
      message: 'Failed to load Discover Control authors',
    })
  }
}

export async function searchDiscoverControlAuthors(req, res) {
  const q = cleanSearch(req.query.q)
  const requestedLimit = Number(req.query.limit || SEARCH_LIMIT)
  const limit = Math.min(
    SEARCH_LIMIT,
    Math.max(1, Number.isFinite(requestedLimit) ? Math.floor(requestedLimit) : SEARCH_LIMIT)
  )

  if (q.length < 2) {
    return res.status(200).json({
      ok: true,
      authors: [],
      limit,
    })
  }

  try {
    let query = supabase
      .from('author_pages')
      .select('id, page_name, page_username, avatar_url, total_followers, status')
      .eq('status', 'active')
      .limit(limit)

    if (isUuid(q)) {
      query = query.eq('id', q)
    } else {
      const safe = cleanLike(q)
      query = query
        .or(`page_name.ilike.%${safe}%,page_username.ilike.%${safe}%`)
        .order('page_name', { ascending: true })
    }

    const { data: pages, error } = await query

    if (error) throw error

    const latestMap = await latestPostsByAuthor(
      (pages || []).map(page => page.id)
    )

    return res.status(200).json({
      ok: true,
      authors: (pages || [])
        .map(page => formatAuthor(page, latestMap.get(String(page.id)) || null))
        .slice(0, limit),
      limit,
    })
  } catch (error) {
    console.error('ADMIN DISCOVER CONTROL SEARCH ERROR:', error)
    return res.status(500).json({
      ok: false,
      message: 'Failed to search Author Pages',
    })
  }
}

export async function addDiscoverControlAuthor(req, res) {
  const authorPageId = String(req.body?.author_page_id || '').trim()

  if (!isUuid(authorPageId)) {
    return res.status(400).json({
      ok: false,
      message: 'Invalid Author Page ID',
    })
  }

  try {
    const passkey = await verifyPasskey(req, 'discover_control_add')

    if (!passkey.ok) {
      return res.status(passkey.status).json(passkey.body)
    }

    const [{ data: page, error: pageError }, { count, error: countError }, { data: existing, error: existingError }] =
      await Promise.all([
        supabase
          .from('author_pages')
          .select('id, status')
          .eq('id', authorPageId)
          .maybeSingle(),
        supabase
          .from('admin_discover_control_authors')
          .select('author_page_id', { count: 'exact', head: true }),
        supabase
          .from('admin_discover_control_authors')
          .select('author_page_id')
          .eq('author_page_id', authorPageId)
          .maybeSingle(),
      ])

    if (pageError) throw pageError
    if (countError) throw countError
    if (existingError) throw existingError

    if (!page || String(page.status || '').toLowerCase() !== 'active') {
      return res.status(404).json({
        ok: false,
        message: 'Active Author Page not found',
      })
    }

    if (existing) {
      return res.status(409).json({
        ok: false,
        message: 'Author Page already selected',
      })
    }

    if (Number(count || 0) >= MAX_SELECTED) {
      return res.status(409).json({
        ok: false,
        message: 'Maximum 10 Author Pages allowed',
      })
    }

    const { adminId, adminEmail } = getAdminIdentity(req.admin)

    const { error: insertError } = await supabase
      .from('admin_discover_control_authors')
      .insert({
        author_page_id: authorPageId,
        added_by_admin_id: adminId || null,
        added_by_admin_email: adminEmail || null,
      })

    if (insertError) {
      if (/maximum of 10/i.test(String(insertError.message || ''))) {
        return res.status(409).json({
          ok: false,
          message: 'Maximum 10 Author Pages allowed',
        })
      }

      throw insertError
    }

    invalidateDiscoverAuthorPostsSharedCache()

    return res.status(200).json({
      ok: true,
      author_page_id: authorPageId,
    })
  } catch (error) {
    console.error('ADMIN DISCOVER CONTROL ADD ERROR:', error)
    return res.status(500).json({
      ok: false,
      message: 'Failed to add Author Page',
    })
  }
}

export async function removeDiscoverControlAuthor(req, res) {
  const authorPageId = String(req.params.authorPageId || '').trim()

  if (!isUuid(authorPageId)) {
    return res.status(400).json({
      ok: false,
      message: 'Invalid Author Page ID',
    })
  }

  try {
    const passkey = await verifyPasskey(req, 'discover_control_remove')

    if (!passkey.ok) {
      return res.status(passkey.status).json(passkey.body)
    }

    const { data, error } = await supabase
      .from('admin_discover_control_authors')
      .delete()
      .eq('author_page_id', authorPageId)
      .select('author_page_id')
      .maybeSingle()

    if (error) throw error

    if (!data) {
      return res.status(404).json({
        ok: false,
        message: 'Author Page is not selected',
      })
    }

    invalidateDiscoverAuthorPostsSharedCache()

    return res.status(200).json({
      ok: true,
      author_page_id: authorPageId,
    })
  } catch (error) {
    console.error('ADMIN DISCOVER CONTROL REMOVE ERROR:', error)
    return res.status(500).json({
      ok: false,
      message: 'Failed to remove Author Page',
    })
  }
}
