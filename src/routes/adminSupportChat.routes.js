import express from 'express'
import { rateLimit } from 'express-rate-limit'
import { supabase } from '../config/supabase.js'
import { requireAdminPermission } from '../middleware/adminPermission.middleware.js'ា
import { normalizeSmartSearch, scoreSmartSearchResult } from '../services/smartSearchCore.service.js'

const router = express.Router()
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const PAGE_SIZE = 10

const preAuthLimit = rateLimit({
  windowMs: 60000,
  limit: 90,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { ok: false, code: 'ADMIN_CHAT_IP_LIMIT', message: 'Too many requests' },
})

const inboxLimit = rateLimit({
  windowMs: 60000,
  limit: 60,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req) => String(req.admin.admin_id),
  message: { ok: false, code: 'ADMIN_CHAT_READ_LIMIT', message: 'Too many inbox requests' },
})

const searchLimit = rateLimit({
  windowMs: 60000,
  limit: 30,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req) => String(req.admin.admin_id),
  message: { ok: false, code: 'ADMIN_CHAT_SEARCH_LIMIT', message: 'Too many search requests' },
})

const viewChat = requireAdminPermission('admin_chat.view')

function problem(res, status, code, message) {
  return res.status(status).json({ ok: false, code, message })
}

function failed(res, error, kind) {
  console.error('ADMIN_SUPPORT_CHAT_READ_FAILED', kind, error?.code || 'UNKNOWN')
  return problem(res, 503, 'ADMIN_CHAT_READ_UNAVAILABLE', 'Admin Chat is temporarily unavailable')
}

function normalizeLookup(raw) {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 400) return null
  let value = raw.trim()
  if (/^https?:\/\//i.test(value)) {
    let url
    try {
      url = new URL(value)
    } catch {
      return null
    }
    if (!['shadowerabook.site', 'www.shadowerabook.site'].includes(url.hostname.toLowerCase())) return null
    const reference = ['id', 'uid', 'user_id', 'username', 'user']
      .map((key) => url.searchParams.get(key))
      .find(Boolean)
    value = reference || url.pathname.split('/').filter(Boolean).pop() || ''
    try {
      value = decodeURIComponent(value)
    } catch {
      return null
    }
  }
  value = normalizeSmartSearch(value.replace(/^@+/, ''), 80)
  if (UUID.test(value)) return { id: value.toLowerCase(), term: '' }
  if (Array.from(value).length < 2 || value.length > 80 || !/^[\p{L}\p{M}\p{N}._\-\s]+$/u.test(value)) return null
  return { id: '', term: value }
}

function rankPerson(person, term) {
  if (!term) return 0
  const q = normalizeSmartSearch(term)
  const username = normalizeSmartSearch(person.username)
  const name = normalizeSmartSearch(person.name)
  const authorName = normalizeSmartSearch(person.author_page?.name)
  const authorUsername = normalizeSmartSearch(person.author_page?.username)
  if (username === q) return 1500
  if (name === q) return 1450
  if (authorUsername === q) return 1400
  if (authorName === q) return 1350
  return Math.max(
    scoreSmartSearchResult(q, [person.username, person.name]),
    scoreSmartSearchResult(q, [person.author_page?.name, person.author_page?.username]),
  )
}

router.get('/conversations', preAuthLimit, viewChat, inboxLimit, async (req, res) => {
  const filter = typeof req.query.filter === 'string' ? req.query.filter : 'all'
  if (!['all', 'unread', 'seen', 'assigned', 'archived'].includes(filter)) {
    return problem(res, 400, 'ADMIN_CHAT_INVALID_FILTER', 'Invalid inbox filter')
  }

  const pageInput = req.query.page
  if (pageInput !== undefined && (typeof pageInput !== 'string' || !/^[1-9]\d{0,4}$/.test(pageInput))) {
    return problem(res, 400, 'ADMIN_CHAT_INVALID_PAGE', 'Invalid page number')
  }
  const pageNumber = pageInput === undefined ? 1 : Number(pageInput)
  if (pageNumber > 10000) return problem(res, 400, 'ADMIN_CHAT_INVALID_PAGE', 'Invalid page number')
  const start = (pageNumber - 1) * PAGE_SIZE

  try {
    let query = supabase
      .from('admin_support_conversations')
      .select('id, reader_user_id, status, priority, detected_country_code, override_country_code, assigned_admin_id, assigned_mode, last_message_at, last_message_preview, unread_for_admin, unread_for_reader, archived_at, created_at')

    if (filter === 'archived') {
      query = query.eq('status', 'archived')
        .order('archived_at', { ascending: false })
        .order('id', { ascending: false })
    } else {
      query = query.neq('status', 'archived')
        .order('last_message_at', { ascending: false, nullsFirst: false })
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
      if (filter === 'unread') query = query.gt('unread_for_admin', 0)
      if (filter === 'seen') query = query.eq('unread_for_admin', 0)
      if (filter === 'assigned') query = query.not('assigned_admin_id', 'is', null)
    }

    if (req.admin.role === 'staff') {
      query = query.eq('assigned_admin_id', String(req.admin.admin_id))
    }

    const { data, error } = await query.range(start, start + PAGE_SIZE)
    if (error) throw error
    const hasMore = (data || []).length > PAGE_SIZE
    const page = (data || []).slice(0, PAGE_SIZE)
    const userIds = [...new Set(page.map((row) => row.reader_user_id).filter(Boolean))]
    let users = []
    if (userIds.length) {
      const profiles = await supabase.from('users')
        .select('id, name, username, avatar_url, is_author')
        .in('id', userIds).limit(PAGE_SIZE)
      if (profiles.error) throw profiles.error
      users = profiles.data || []
    }
    const byId = new Map(users.map((user) => [user.id, user]))
    const conversations = page.map((chat) => ({
      ...chat,
      reader: byId.get(chat.reader_user_id) || null,
    }))
    res.set('Cache-Control', 'no-store')
    return res.json({
      ok: true,
      conversations,
      limit: PAGE_SIZE,
      page: pageNumber,
      next_page: hasMore ? pageNumber + 1 : null,
      has_more: hasMore,
    })
  } catch (error) {
    return failed(res, error, 'inbox')
  }
})

// Pilot: shared fuzzy search is limited to this single Admin Chat account-search endpoint.
router.get('/users/search', preAuthLimit, viewChat, searchLimit, async (req, res) => {
  const lookup = normalizeLookup(req.query.q)
  if (!lookup) return problem(res, 400, 'ADMIN_CHAT_INVALID_SEARCH', 'Enter a name, username, account link or user ID')

  try {
    let userQuery = supabase.from('users')
      .select('id, name, username, avatar_url, is_author')
      .eq('is_active', true)
    let pagesQuery = supabase.from('author_pages')
      .select('id, user_id, page_name, page_username, page_slug')
      .eq('status', 'active')

    if (lookup.id) {
      userQuery = userQuery.eq('id', lookup.id)
      pagesQuery = pagesQuery.eq('id', lookup.id)
    } else {
      const token = lookup.term
      userQuery = userQuery.or(`name.ilike.%${token}%,username.ilike.%${token}%`)
      pagesQuery = pagesQuery.or(`page_name.ilike.%${token}%,page_username.ilike.%${token}%,page_slug.ilike.%${token}%`)
    }

    const [userResult, pageResult] = await Promise.all([
      userQuery.limit(PAGE_SIZE),
      pagesQuery.limit(PAGE_SIZE),
    ])
    if (userResult.error) throw userResult.error
    if (pageResult.error) throw pageResult.error

    const people = new Map((userResult.data || []).map((user) => [user.id, { ...user, author_page: null }]))
    const missingIds = [...new Set((pageResult.data || []).map((page) => page.user_id).filter((id) => id && !people.has(id)))].slice(0, PAGE_SIZE)
    if (missingIds.length) {
      const missing = await supabase.from('users')
        .select('id, name, username, avatar_url, is_author')
        .eq('is_active', true).in('id', missingIds).limit(PAGE_SIZE)
      if (missing.error) throw missing.error
      for (const user of missing.data || []) people.set(user.id, { ...user, author_page: null })
    }
    for (const page of pageResult.data || []) {
      const user = people.get(page.user_id)
      if (user && !user.author_page) user.author_page = {
        id: page.id, name: page.page_name, username: page.page_username || page.page_slug || '',
      }
    }

    // Only attempt a database-wide fuzzy lookup after direct search found nothing.
    // This reuses the already tested, service-role-only Reader Classification RPC.
    // It does not run on page entry, in the background, or on every keystroke.
    if (!lookup.id && Array.from(lookup.term).length >= 3 && people.size === 0) {
      const { data: fuzzy, error: fuzzyError } = await supabase.rpc('get_admin_reader_classification_analytics', {
        p_search: lookup.term,
        p_group: 'all',
        p_limit: PAGE_SIZE,
      })
      if (fuzzyError) {
        // Preserve existing exact search if the optional fuzzy RPC is unavailable.
        console.error('ADMIN_CHAT_FUZZY_SEARCH_UNAVAILABLE', fuzzyError.code || 'UNKNOWN')
      } else if (fuzzy?.ok === true && Array.isArray(fuzzy.items) && fuzzy.items.length) {
        const candidateIds = [...new Set(fuzzy.items.map((item) => item.id).filter((id) => UUID.test(String(id))))].slice(0, PAGE_SIZE)
        if (candidateIds.length) {
          const candidates = await supabase.from('users')
            .select('id, name, username, avatar_url, is_author')
            .eq('is_active', true).in('id', candidateIds).limit(PAGE_SIZE)
          if (candidates.error) throw candidates.error
          const byId = new Map((candidates.data || []).map((user) => [user.id, user]))
          // Keep SQL's global exact/prefix/fuzzy ranking; never rank only the latest page.
          for (const id of candidateIds) {
            const user = byId.get(id)
            if (user) people.set(id, { ...user, author_page: null })
          }
        }
      }
    }

    const users = [...people.values()]
    if (lookup.term && ((userResult.data || []).length || (pageResult.data || []).length)) {
      users.sort((a, b) => rankPerson(b, lookup.term) - rankPerson(a, lookup.term))
    }
    res.set('Cache-Control', 'no-store')
    return res.json({ ok: true, users: users.slice(0, PAGE_SIZE), limit: PAGE_SIZE })
  } catch (error) {
    return failed(res, error, 'search')
  }
})

router.get('/conversations/:conversationId/messages', preAuthLimit, viewChat, inboxLimit, async (req, res) => {
  const id = req.params.conversationId
  const before = req.query.before
  if (!UUID.test(id)) return problem(res, 400, 'ADMIN_CHAT_INVALID_ID', 'Invalid conversation ID')
  if (before !== undefined && (typeof before !== 'string' || !Number.isFinite(Date.parse(before)) || before.length > 50)) {
    return problem(res, 400, 'ADMIN_CHAT_INVALID_CURSOR', 'Invalid message cursor')
  }

  try {
    let scope = supabase.from('admin_support_conversations')
      .select('id').eq('id', id)
    if (req.admin.role === 'staff') {
      scope = scope.eq('assigned_admin_id', String(req.admin.admin_id))
    }
    const existing = await scope.maybeSingle()
    if (existing.error) throw existing.error
    if (!existing.data) return problem(res, 404, 'ADMIN_CHAT_NOT_FOUND', 'Conversation not found')

    let query = supabase.from('admin_support_messages')
      .select('id, conversation_id, sender_kind, sender_admin_id, public_support_id, message_text, attachments, seen_at, created_at, edited_at, deleted_at, reply_to_message_id')
      .eq('conversation_id', id).order('created_at', { ascending: false })
    if (before) query = query.lt('created_at', new Date(before).toISOString())
    const { data, error } = await query.limit(21)
    if (error) throw error
    const page = (data || []).slice(0, 20).map(message =>
  message.deleted_at
    ? { ...message, message_text: 'Message deleted', attachments: [] }
    : message
)
    const adminIds = [...new Set(page.filter((message) => message.sender_kind === 'admin').map((message) => message.sender_admin_id).filter(Boolean))]
    let admins = []
    if (adminIds.length) {
      const accounts = await supabase.from('admin_users')
        .select('id, name, role')
        .in('id', adminIds).limit(20)
      if (accounts.error) throw accounts.error
      admins = accounts.data || []
    }
    const adminById = new Map(admins.map((account) => [String(account.id), account]))
    const messages = page.reverse().map((message) => {
      if (message.sender_kind !== 'admin') return message
      const account = adminById.get(String(message.sender_admin_id))
      return {
        ...message,
        sender_admin_name: account?.name || null,
        sender_admin_role: account?.role || null,
      }
    })
    res.set('Cache-Control', 'no-store')
    return res.json({
      ok: true,
      messages,
      limit: 20,
      has_more: (data || []).length > 20,
      next_before: page.length ? page[0].created_at : null,
    })
  } catch (error) {
    return failed(res, error, 'messages')
  }
})

export default router
