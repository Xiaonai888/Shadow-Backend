import { supabase } from '../config/supabase.js'

function clampNumber(value, fallback, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(Math.max(Math.trunc(number), min), max)
}

function startOfMonthIso() {
  const now = new Date()
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0)).toISOString()
}

function cleanReader(user) {
  return {
    id: user.id,
    name: user.name || '',
    username: user.username || '',
    email: user.email || '',
    status: user.is_active === false ? 'inactive' : 'active',
    is_author: Boolean(user.is_author),
    joined_at: user.created_at || null,
    updated_at: user.updated_at || null,
  }
}

export async function getAdminCommunityReaders(req, res) {
  try {
    const page = clampNumber(req.query.page, 1, 1, 100000)
    const limit = clampNumber(req.query.limit, 20, 1, 100)
    const q = String(req.query.q || '').trim()
    const from = (page - 1) * limit
    const to = from + limit - 1

    let query = supabase
      .from('users')
      .select('id, name, username, email, is_active, is_author, created_at, updated_at', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(from, to)

    if (q) {
      const safe = q.replace(/[%_]/g, '')
      query = query.or(`name.ilike.%${safe}%,username.ilike.%${safe}%,email.ilike.%${safe}%`)
    }

    const { data, error, count } = await query
    if (error) throw error

    const { count: totalReaders, error: totalReadersError } = await supabase
      .from('users')
      .select('id', { count: 'exact', head: true })

    if (totalReadersError) throw totalReadersError

    const { count: totalAuthors, error: totalAuthorsError } = await supabase
      .from('users')
      .select('id', { count: 'exact', head: true })
      .eq('is_author', true)

    if (totalAuthorsError) throw totalAuthorsError

    const { count: newThisMonth, error: newThisMonthError } = await supabase
      .from('users')
      .select('id', { count: 'exact', head: true })
      .gte('created_at', startOfMonthIso())

    if (newThisMonthError) throw newThisMonthError

    const total = count || 0
    const totalPages = Math.max(1, Math.ceil(total / limit))

    return res.status(200).json({
      ok: true,
      summary: {
        total_readers: totalReaders || 0,
        total_authors: totalAuthors || 0,
        total_community_members: totalReaders || 0,
        new_this_month: newThisMonth || 0,
      },
      readers: (data || []).map(cleanReader),
      page,
      limit,
      total,
      total_pages: totalPages,
      has_next: page < totalPages,
      has_prev: page > 1,
    })
  } catch (error) {
    console.error('ADMIN_COMMUNITY_READERS_ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to load community readers' })
  }
}
