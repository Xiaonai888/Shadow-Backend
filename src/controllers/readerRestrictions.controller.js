import { supabase } from '../config/supabase.js'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const PAGE_SIZE = 10
const SEARCH_LIMIT = 8
const PUBLIC_HOSTS = new Set(['shadowerabook.site', 'www.shadowerabook.site'])

function ownerId(req) {
  return String(req.user?.user_id || '').trim().toLowerCase()
}

function fail(res, status, code, message) {
  res.set('Cache-Control', 'private, no-store')
  return res.status(status).json({ ok: false, code, message })
}

function unexpected(res, action, error) {
  console.error(`READER_RESTRICT_${action}_ERROR:`, error)
  return fail(res, 503, 'RESTRICTION_UNAVAILABLE', 'Restricted readers are temporarily unavailable.')
}

function integerInRange(value, fallback, min, max) {
  if (value === undefined) return fallback
  const number = Number(value)
  if (!Number.isSafeInteger(number)) return fallback
  return Math.min(max, Math.max(min, number))
}

function cleanSearchText(input) {
  return String(input || '')
    .normalize('NFKC')
    .replace(/[^\p{L}\p{M}\p{N} ._\-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
}

function parsePersonQuery(raw) {
  const input = String(raw || '').trim().slice(0, 500)
  if (!input) return { value: '', exact: false }
  if (/^https?:\/\//i.test(input) || input.startsWith('/')) {
    try {
      const url = new URL(input, 'https://www.shadowerabook.site')
      if (!PUBLIC_HOSTS.has(url.hostname.toLowerCase())) return { value: '', exact: true }
      const value = url.pathname.replace(/\/+$/, '') === '/profile' ? url.searchParams.get('username') : ''
      return { value: cleanSearchText(String(value || '').replace(/^@+/, '')), exact: true }
    } catch {
      return { value: '', exact: true }
    }
  }
  return { value: cleanSearchText(input.replace(/^@+/, '')), exact: input.startsWith('@') }
}

async function findAccountFlags(owner, ids) {
  if (!ids.length) return new Map()
  const [restricted, blockedByOwner, blockingOwner] = await Promise.all([
    supabase.from('reader_restricted_accounts').select('restricted_user_id').eq('owner_user_id', owner).in('restricted_user_id', ids),
    supabase.from('chat_blocks').select('blocked_user_id').eq('blocker_user_id', owner).in('blocked_user_id', ids),
    supabase.from('chat_blocks').select('blocker_user_id').eq('blocked_user_id', owner).in('blocker_user_id', ids),
  ])
  if (restricted.error || blockedByOwner.error || blockingOwner.error) {
    throw restricted.error || blockedByOwner.error || blockingOwner.error
  }
  const restrictedIds = new Set((restricted.data || []).map((row) => String(row.restricted_user_id)))
  const blockedIds = new Set([
    ...(blockedByOwner.data || []).map((row) => String(row.blocked_user_id)),
    ...(blockingOwner.data || []).map((row) => String(row.blocker_user_id)),
  ])
  return new Map(ids.map((id) => [id, blockedIds.has(id) ? 'blocked' : restrictedIds.has(id) ? 'restricted' : 'available']))
}

export async function listMyRestrictedReaders(req, res) {
  const owner = ownerId(req)
  if (!UUID_PATTERN.test(owner)) return fail(res, 401, 'UNAUTHORIZED', 'Please sign in again.')

  const offset = integerInRange(req.query?.offset, 0, 0, 9990)
  const limit = integerInRange(req.query?.limit, PAGE_SIZE, 1, PAGE_SIZE)
  const query = cleanSearchText(req.query?.q).replace(/^@+/, '')

  try {
    const { data, error } = await supabase.rpc('get_reader_restricted_page', {
      p_owner: owner,
      p_query: query,
      p_offset: offset,
      p_limit: limit,
    })
    if (error) throw error
    if (!data || !Array.isArray(data.results) || !Number.isSafeInteger(data.total) || typeof data.has_more !== 'boolean') {
      throw new Error('Invalid restricted reader page response')
    }
    res.set('Cache-Control', 'private, no-store')
    return res.status(200).json({ ok: true, results: data.results, total: data.total, has_more: data.has_more })
  } catch (error) {
    return unexpected(res, 'LIST', error)
  }
}

export async function searchReadersForRestriction(req, res) {
  const owner = ownerId(req)
  if (!UUID_PATTERN.test(owner)) return fail(res, 401, 'UNAUTHORIZED', 'Please sign in again.')
  const { value, exact } = parsePersonQuery(req.query?.q)
  if (!value || (!exact && value.length < 2)) {
    res.set('Cache-Control', 'private, no-store')
    return res.status(200).json({ ok: true, results: [] })
  }

  try {
    let query = supabase.from('users')
      .select('id,name,username,avatar_url')
      .eq('is_active', true)
      .neq('id', owner)
    query = exact ? query.ilike('username', value) : query.or(`name.ilike.%${value}%,username.ilike.%${value}%`)
    const { data, error } = await query.order('username', { ascending: true }).limit(SEARCH_LIMIT)
    if (error) throw error
    const accounts = data || []
    const flags = await findAccountFlags(owner, accounts.map((row) => String(row.id)))
    res.set('Cache-Control', 'private, no-store')
    return res.status(200).json({
      ok: true,
      results: accounts.map((row) => ({
        id: row.id,
        name: row.name || row.username || 'Reader',
        username: row.username || '',
        avatar_url: row.avatar_url || null,
        status: flags.get(String(row.id)) || 'unavailable',
      })),
    })
  } catch (error) {
    return unexpected(res, 'SEARCH', error)
  }
}

export async function restrictReader(req, res) {
  const owner = ownerId(req)
  const targetId = String(req.params?.readerId || '').trim().toLowerCase()
  if (!UUID_PATTERN.test(owner)) return fail(res, 401, 'UNAUTHORIZED', 'Please sign in again.')
  if (!UUID_PATTERN.test(targetId)) return fail(res, 400, 'INVALID_READER_ID', 'Invalid reader ID.')
  if (owner === targetId) return fail(res, 400, 'CANNOT_RESTRICT_SELF', 'You cannot restrict yourself.')

  try {
    const { data: target, error: targetError } = await supabase.from('users')
      .select('id').eq('id', targetId).eq('is_active', true).maybeSingle()
    if (targetError) throw targetError
    if (!target) return fail(res, 404, 'READER_NOT_FOUND', 'Reader not found.')

    const { data: blocks, error: blockError } = await supabase.from('chat_blocks')
      .select('id')
      .or(`and(blocker_user_id.eq.${owner},blocked_user_id.eq.${targetId}),and(blocker_user_id.eq.${targetId},blocked_user_id.eq.${owner})`)
      .limit(1)
    if (blockError) throw blockError
    if (blocks?.length) return fail(res, 409, 'READER_BLOCKED', 'Blocked readers cannot be restricted.')

    const { error } = await supabase.from('reader_restricted_accounts')
      .insert({ owner_user_id: owner, restricted_user_id: targetId })
    if (error && error.code !== '23505') throw error
    res.set('Cache-Control', 'private, no-store')
    return res.status(200).json({ ok: true, reader_id: targetId, is_restricted: true })
  } catch (error) {
    return unexpected(res, 'ADD', error)
  }
}

export async function unrestrictReader(req, res) {
  const owner = ownerId(req)
  const targetId = String(req.params?.readerId || '').trim().toLowerCase()
  if (!UUID_PATTERN.test(owner)) return fail(res, 401, 'UNAUTHORIZED', 'Please sign in again.')
  if (!UUID_PATTERN.test(targetId)) return fail(res, 400, 'INVALID_READER_ID', 'Invalid reader ID.')
  if (owner === targetId) return fail(res, 400, 'CANNOT_RESTRICT_SELF', 'You cannot restrict yourself.')

  try {
    const { error } = await supabase.from('reader_restricted_accounts').delete()
      .eq('owner_user_id', owner).eq('restricted_user_id', targetId)
    if (error) throw error
    res.set('Cache-Control', 'private, no-store')
    return res.status(200).json({ ok: true, reader_id: targetId, is_restricted: false })
  } catch (error) {
    return unexpected(res, 'REMOVE', error)
  }
}
