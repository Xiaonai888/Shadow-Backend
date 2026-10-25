import express from 'express'
import { rateLimit } from 'express-rate-limit'
import { supabase } from '../config/supabase.js'
import { requireAdminPermission } from '../middleware/adminPermission.middleware.js'

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
  value = value.replace(/^@+/, '').normalize('NFKC').trim()
  if (UUID.test(value)) return { id: value.toLowerCase(), term: '' }
  if (value.length < 2 || value.length > 80 || !/^[\p{L}\p{M}\p{N}._\-\s]+$/u.test(value)) return null
  return { id: '', term: value.replace(/\s+/g, ' ') }
}

function rankPerson(person, term) {
  const q = term.toLocaleLowerCase()
  const username = String(person.username || '').toLocaleLowerCase()
  const name = String(person.name || '').toLocaleLowerCase()
  if (username === q) return 4
  if (name === q) return 3
  if (username.startsWith(q)) return 2
  if (name.startsWith(q)) return 1
  return 0
}

router.get('/conversations', preAuthLimit, viewChat, inboxLimit, async (req, res) => {
  const filter = typeof req.query.filter === 'string' ? req.query.filter : 'all'
  if (!['all', 'unread', 'seen', 'assigned', 'archived'].includes(filter)) {
    return problem(res, 400, 'ADMIN_CHAT_INVALID_FILTER', 'Invalid inbox filter')
  }

  try {
    let query = supabase
      .from('admin_support_conversations')
      .select('id, reader_user_id, status, priority, detected_country_code, override_country_code, assigned_admin_id, assigned_mode, last_message_at, last_message_preview, unread_for_admin, unread_for_reader, archived_at, created_at')

    if (filter === 'archived') {
      query = query.eq('status', 'archived').order('archived_at', { ascending: false })
    } else {
      query = query.neq('status', 'archived')
        .order('last_message_at', { ascending: false, nullsFirst: false })
        .order('created_at', { ascending: false })
      if (filter === 'unread') query = query.gt('unread_for_admin', 0)
      if (filter === 'seen') query = query.eq('unread_for_admin', 0)
      if (filter === 'assigned') query = query.not('assigned_admin_id', 'is', null)
    }

    const { data, error } = await query.limit(PAGE_SIZE + 1)
    if (error) throw error
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
    return res.json({ ok: true, conversations, limit: PAGE_SIZE, has_more: (data || []).length > PAGE_SIZE })
  } catch (error) {
    return failed(res, error, 'inbox')
  }
})

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
      const token = lookup.term.replace(/\s+/g, ' ')
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

    const users = [...people.values()]
      .sort((a, b) => rankPerson(b, lookup.term) - rankPerson(a, lookup.term))
      .slice(0, PAGE_SIZE)
    res.set('Cache-Control', 'no-store')
    return res.json({ ok: true, users, limit: PAGE_SIZE })
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
    const existing = await supabase.from('admin_support_conversations')
      .select('id').eq('id', id).maybeSingle()
    if (existing.error) throw existing.error
    if (!existing.data) return problem(res, 404, 'ADMIN_CHAT_NOT_FOUND', 'Conversation not found')

    let query = supabase.from('admin_support_messages')
      .select('id, conversation_id, sender_kind, public_support_id, message_text, attachments, seen_at, created_at')
      .eq('conversation_id', id).order('created_at', { ascending: false })
    if (before) query = query.lt('created_at', new Date(before).toISOString())
    const { data, error } = await query.limit(21)
    if (error) throw error
    const page = (data || []).slice(0, 20)
    res.set('Cache-Control', 'no-store')
    return res.json({
      ok: true,
      messages: page.reverse(),
      limit: 20,
      has_more: (data || []).length > 20,
      next_before: page.length ? page[0].created_at : null,
    })
  } catch (error) {
    return failed(res, error, 'messages')
  }
})

export default router
