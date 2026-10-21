import { supabase } from '../config/supabase.js'

const MAX_RESULTS = 8
const PUBLIC_HOSTS = new Set(['shadowerabook.site', 'www.shadowerabook.site'])

function normalizeQuery(value, type) {
  const input = String(value || '').trim().slice(0, 500)
  if (!input) return { query: '', exact: false }

  if (/^https?:\/\//i.test(input) || input.startsWith('/')) {
    try {
      const url = new URL(input, 'https://www.shadowerabook.site')
      if (!PUBLIC_HOSTS.has(url.hostname.toLowerCase())) return { query: '', exact: true }
      const parts = url.pathname.split('/').filter(Boolean)
      let username = ''
      if (type === 'reader' && parts.length === 1 && parts[0] === 'profile') {
        username = url.searchParams.get('username') || ''
      }
      if (type === 'page' && parts.length === 3 && parts[0] === 'author' && parts[1] === 'page') {
        username = parts[2]
      }
      return { query: cleanSearchText(username.replace(/^@+/, '')), exact: true }
    } catch {
      return { query: '', exact: true }
    }
  }

  const exact = input.startsWith('@')
  return { query: cleanSearchText(input.replace(/^@+/, '')), exact }
}

function cleanSearchText(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/[^\p{L}\p{M}\p{N} ._\-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
}

export async function searchReaderBlockTargets(req, res) {
  const userId = String(req.user?.user_id || '').trim()
  const type = String(req.query?.type || '').trim().toLowerCase()

  if (!userId) return res.status(401).json({ ok: false, message: 'Unauthorized' })
  if (!['reader', 'page'].includes(type)) {
    return res.status(400).json({ ok: false, message: 'Invalid block target type' })
  }

  const { query, exact } = normalizeQuery(req.query?.q, type)
  if ((!exact && query.length < 2) || !query) {
    return res.status(200).json({ ok: true, results: [] })
  }

  try {
    let request
    if (type === 'reader') {
      request = supabase
        .from('users')
        .select('id, name, username, avatar_url')
        .eq('is_active', true)
        .neq('id', userId)
      request = exact
        ? request.eq('username', query)
        : request.or(`name.ilike.%${query}%,username.ilike.%${query}%`)
    } else {
      request = supabase
        .from('author_pages')
        .select('id, user_id, page_name, page_username, avatar_url')
        .eq('status', 'active')
        .neq('user_id', userId)
      request = exact
        ? request.eq('page_username', query)
        : request.or(`page_name.ilike.%${query}%,page_username.ilike.%${query}%`)
    }

    const { data, error } = await request.limit(MAX_RESULTS)
    if (error) throw error

    return res.status(200).json({
      ok: true,
      results: (data || []).map((target) => ({
        ...target,
        target_type: type,
      })),
    })
  } catch (error) {
    console.error('SEARCH READER BLOCK TARGETS ERROR:', error)
    return res.status(500).json({
      ok: false,
      message: 'Failed to search block targets',
    })
  }
}
