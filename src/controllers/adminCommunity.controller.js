import { supabase } from '../config/supabase.js'

function toPositiveInt(value, fallback, max) {
  const number = Number.parseInt(String(value || ''), 10)
  if (!Number.isFinite(number) || number < 1) return fallback
  return Math.min(number, max)
}

function getMonthStartIso() {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), 1).toISOString()
}

function cleanSearch(value) {
  return String(value || '').trim().replace(/[%_,()]/g, ' ')
}

async function getOverviewData() {
  const monthStart = getMonthStartIso()

  const [readersResult, authorsResult, newReadersResult] = await Promise.all([
    supabase.from('users').select('id', { count: 'exact', head: true }),
    supabase.from('author_pages').select('id', { count: 'exact', head: true }),
    supabase.from('users').select('id', { count: 'exact', head: true }).gte('created_at', monthStart),
  ])

  if (readersResult.error) throw readersResult.error
  if (authorsResult.error) throw authorsResult.error
  if (newReadersResult.error) throw newReadersResult.error

  const totalReaders = readersResult.count || 0
  const totalAuthors = authorsResult.count || 0
  const newReaders = newReadersResult.count || 0

  return {
    total_readers: totalReaders,
    total_authors: totalAuthors,
    total_community_members: totalReaders,
    new_this_month: newReaders,
  }
}

function formatReader(user) {
  return {
    id: user.id,
    name: user.name || user.username || 'Reader',
    username: user.username || '',
    email: user.email || '',
    avatar_url: user.avatar_url || '',
    status: user.is_active === false ? 'inactive' : 'active',
    is_author: Boolean(user.is_author),
    joined_at: user.created_at,
  }
}

function formatAuthor(page, userMap, storyCountMap) {
  const user = userMap.get(page.user_id) || {}

  return {
    id: page.id,
    user_id: page.user_id,
    author_name: page.page_name || user.name || 'Author',
    username: page.page_username || page.page_slug || user.username || '',
    email: user.email || '',
    avatar_url: page.avatar_url || user.avatar_url || '',
    books_count: storyCountMap.get(page.id) || 0,
    status: page.status || (user.is_active === false ? 'inactive' : 'active'),
    joined_at: page.created_at,
    updated_at: page.updated_at,
  }
}

export async function getAdminCommunityOverview(req, res) {
  try {
    const summary = await getOverviewData()

    return res.status(200).json({
      ok: true,
      summary,
    })
  } catch (error) {
    console.error('ADMIN COMMUNITY OVERVIEW ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to load community overview', error: error.message })
  }
}

export async function getAdminCommunityReaders(req, res) {
  try {
    const page = toPositiveInt(req.query.page, 1, 100000)
    const limit = toPositiveInt(req.query.limit, 20, 100)
    const q = cleanSearch(req.query.q)
    const from = (page - 1) * limit
    const to = from + limit - 1

    let query = supabase
      .from('users')
      .select('id, name, username, email, avatar_url, is_active, is_author, created_at', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(from, to)

    if (q) {
      query = query.or(`name.ilike.%${q}%,username.ilike.%${q}%,email.ilike.%${q}%`)
    }

    const { data, error, count } = await query

    if (error) throw error

    const total = count || 0
    const totalPages = Math.max(1, Math.ceil(total / limit))

    return res.status(200).json({
      ok: true,
      readers: (data || []).map(formatReader),
      page,
      limit,
      total,
      total_pages: totalPages,
      has_next: page < totalPages,
      has_prev: page > 1,
    })
  } catch (error) {
    console.error('ADMIN COMMUNITY READERS ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to load readers', error: error.message })
  }
}

export async function getAdminCommunityAuthors(req, res) {
  try {
    const page = toPositiveInt(req.query.page, 1, 100000)
    const limit = toPositiveInt(req.query.limit, 20, 100)
    const q = cleanSearch(req.query.q)
    const from = (page - 1) * limit
    const to = from + limit - 1

    let query = supabase
      .from('author_pages')
      .select('id, user_id, page_name, page_username, page_slug, avatar_url, status, created_at, updated_at', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(from, to)

    if (q) {
      query = query.or(`page_name.ilike.%${q}%,page_username.ilike.%${q}%,page_slug.ilike.%${q}%`)
    }

    const { data, error, count } = await query

    if (error) throw error

    const authorPages = data || []
    const userIds = [...new Set(authorPages.map((pageItem) => pageItem.user_id).filter(Boolean))]
    const authorIds = authorPages.map((pageItem) => pageItem.id).filter(Boolean)
    const userMap = new Map()
    const storyCountMap = new Map()

    if (userIds.length) {
      const { data: users, error: usersError } = await supabase
        .from('users')
        .select('id, name, username, email, avatar_url, is_active')
        .in('id', userIds)

      if (usersError) throw usersError

      ;(users || []).forEach((user) => {
        userMap.set(user.id, user)
      })
    }

    if (authorIds.length) {
      const { data: stories, error: storiesError } = await supabase
        .from('stories')
        .select('id, author_id')
        .in('author_id', authorIds)

      if (!storiesError) {
        ;(stories || []).forEach((story) => {
          storyCountMap.set(story.author_id, (storyCountMap.get(story.author_id) || 0) + 1)
        })
      }
    }

    const total = count || 0
    const totalPages = Math.max(1, Math.ceil(total / limit))

    return res.status(200).json({
      ok: true,
      authors: authorPages.map((pageItem) => formatAuthor(pageItem, userMap, storyCountMap)),
      page,
      limit,
      total,
      total_pages: totalPages,
      has_next: page < totalPages,
      has_prev: page > 1,
    })
  } catch (error) {
    console.error('ADMIN COMMUNITY AUTHORS ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to load authors', error: error.message })
  }
}
