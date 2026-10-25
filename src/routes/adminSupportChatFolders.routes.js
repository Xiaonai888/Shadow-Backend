import express from 'express'
import { rateLimit } from 'express-rate-limit'
import { supabase } from '../config/supabase.js'
import { requireAdminPermission } from '../middleware/adminPermission.middleware.js'

const router = express.Router()
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const ipGuard = rateLimit({
  windowMs: 60000,
  limit: 90,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { ok: false, code: 'ADMIN_FOLDER_IP_LIMIT', message: 'Too many requests' },
})
const identityGuard = rateLimit({
  windowMs: 60000,
  limit: 45,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req) => String(req.admin.admin_id),
  message: { ok: false, code: 'ADMIN_FOLDER_ACTION_LIMIT', message: 'Too many folder requests' },
})
const view = requireAdminPermission('admin_chat.view')
const manage = requireAdminPermission('admin_chat.manage')

function fail(res, status, code, message) {
  return res.status(status).json({ ok: false, code, message })
}

function failed(res, error) {
  if (error?.code === '23505') return fail(res, 409, 'ADMIN_FOLDER_DUPLICATE', 'Folder name already exists')
  console.error('ADMIN_SUPPORT_FOLDER_ERROR', error?.code || 'UNKNOWN')
  return fail(res, 503, 'ADMIN_FOLDER_UNAVAILABLE', 'Support folders are temporarily unavailable')
}

function validName(value) {
  if (typeof value !== 'string') return ''
  const name = value.trim().replace(/\s+/g, ' ')
  return name.length >= 1 && name.length <= 60 ? name : ''
}

function staffScope(req, query) {
  if (req.admin.role !== 'staff') return query
  return query.eq('assigned_admin_id', String(req.admin.admin_id))
}

async function folderExists(folderId) {
  const response = await supabase.from('admin_support_folders').select('id').eq('id', folderId).maybeSingle()
  if (response.error) throw response.error
  return Boolean(response.data)
}

router.get('/folders', ipGuard, view, identityGuard, async (req, res) => {
  try {
    const result = await supabase.from('admin_support_folders')
      .select('id, name, sort_order, created_at')
      .order('sort_order', { ascending: true })
      .order('name', { ascending: true })
      .limit(11)
    if (result.error) throw result.error
    res.set('Cache-Control', 'no-store')
    return res.json({ ok: true, folders: (result.data || []).slice(0, 10), limit: 10, has_more: (result.data || []).length > 10 })
  } catch (error) {
    return failed(res, error)
  }
})

router.get('/folders/:folderId/conversations', ipGuard, view, identityGuard, async (req, res) => {
  const folderId = req.params.folderId
  const page = Number(req.query.page ?? 1)
  if (!UUID.test(folderId) || !Number.isInteger(page) || page < 1 || page > 1000) {
    return fail(res, 400, 'ADMIN_FOLDER_BAD_INPUT', 'Invalid folder or page')
  }
  try {
    if (!await folderExists(folderId)) return fail(res, 404, 'ADMIN_FOLDER_NOT_FOUND', 'Folder not found')
    let query = supabase.from('admin_support_conversations')
      .select('id, reader_user_id, status, priority, assigned_admin_id, last_message_at, last_message_preview, unread_for_admin, created_at, admin_support_folder_members!inner(folder_id)')
      .eq('admin_support_folder_members.folder_id', folderId)
      .neq('status', 'archived')
      .order('last_message_at', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false })
      .range((page - 1) * 10, page * 10)
    query = staffScope(req, query)
    const result = await query
    if (result.error) throw result.error
    const conversations = (result.data || []).slice(0, 10).map(({ admin_support_folder_members, ...conversation }) => conversation)
    const readerIds = [...new Set(conversations.map(item => item.reader_user_id).filter(Boolean))]
    if (readerIds.length) {
      const profiles = await supabase.from('users')
        .select('id, name, username, avatar_url, is_author')
        .in('id', readerIds).limit(10)
      if (profiles.error) throw profiles.error
      const map = new Map((profiles.data || []).map(item => [item.id, item]))
      for (const conversation of conversations) conversation.reader = map.get(conversation.reader_user_id) || null
    }
    res.set('Cache-Control', 'no-store')
    return res.json({ ok: true, conversations, page, limit: 10, has_more: (result.data || []).length > 10 })
  } catch (error) {
    return failed(res, error)
  }
})

router.post('/folders', ipGuard, manage, identityGuard, async (req, res) => {
  const name = validName(req.body?.name)
  if (!name) return fail(res, 400, 'ADMIN_FOLDER_BAD_NAME', 'Folder name must be 1–60 characters')
  try {
    const result = await supabase.from('admin_support_folders')
      .insert({ name, created_by_admin_id: String(req.admin.admin_id) })
      .select('id, name, sort_order, created_at').single()
    if (result.error) throw result.error
    res.set('Cache-Control', 'no-store')
    return res.status(201).json({ ok: true, folder: result.data })
  } catch (error) {
    return failed(res, error)
  }
})

router.patch('/folders/:folderId', ipGuard, manage, identityGuard, async (req, res) => {
  const name = validName(req.body?.name)
  if (!UUID.test(req.params.folderId) || !name) return fail(res, 400, 'ADMIN_FOLDER_BAD_INPUT', 'Invalid folder or name')
  try {
    const result = await supabase.from('admin_support_folders')
      .update({ name }).eq('id', req.params.folderId)
      .select('id, name, sort_order, created_at').maybeSingle()
    if (result.error) throw result.error
    if (!result.data) return fail(res, 404, 'ADMIN_FOLDER_NOT_FOUND', 'Folder not found')
    res.set('Cache-Control', 'no-store')
    return res.json({ ok: true, folder: result.data })
  } catch (error) {
    return failed(res, error)
  }
})

router.delete('/folders/:folderId', ipGuard, manage, identityGuard, async (req, res) => {
  if (!UUID.test(req.params.folderId)) return fail(res, 400, 'ADMIN_FOLDER_BAD_INPUT', 'Invalid folder ID')
  try {
    const result = await supabase.from('admin_support_folders')
      .delete().eq('id', req.params.folderId).select('id').maybeSingle()
    if (result.error) throw result.error
    if (!result.data) return fail(res, 404, 'ADMIN_FOLDER_NOT_FOUND', 'Folder not found')
    res.set('Cache-Control', 'no-store')
    return res.json({ ok: true, deleted_folder_id: result.data.id })
  } catch (error) {
    return failed(res, error)
  }
})

router.post('/folders/:folderId/conversations/:conversationId', ipGuard, manage, identityGuard, async (req, res) => {
  const { folderId, conversationId } = req.params
  if (!UUID.test(folderId) || !UUID.test(conversationId)) return fail(res, 400, 'ADMIN_FOLDER_BAD_INPUT', 'Invalid folder or chat ID')
  try {
    if (!await folderExists(folderId)) return fail(res, 404, 'ADMIN_FOLDER_NOT_FOUND', 'Folder not found')
    let query = supabase.from('admin_support_conversations').select('id').eq('id', conversationId)
    query = staffScope(req, query)
    const chat = await query.maybeSingle()
    if (chat.error) throw chat.error
    if (!chat.data) return fail(res, 404, 'ADMIN_CHAT_NOT_FOUND', 'Conversation not found')
    const result = await supabase.from('admin_support_folder_members').upsert({
      folder_id: folderId,
      conversation_id: conversationId,
      added_by_admin_id: String(req.admin.admin_id),
    }, { onConflict: 'conversation_id,folder_id', ignoreDuplicates: true })
    if (result.error) throw result.error
    res.set('Cache-Control', 'no-store')
    return res.json({ ok: true })
  } catch (error) {
    return failed(res, error)
  }
})

router.delete('/folders/:folderId/conversations/:conversationId', ipGuard, manage, identityGuard, async (req, res) => {
  const { folderId, conversationId } = req.params
  if (!UUID.test(folderId) || !UUID.test(conversationId)) return fail(res, 400, 'ADMIN_FOLDER_BAD_INPUT', 'Invalid folder or chat ID')
  try {
    let query = supabase.from('admin_support_conversations').select('id').eq('id', conversationId)
    query = staffScope(req, query)
    const chat = await query.maybeSingle()
    if (chat.error) throw chat.error
    if (!chat.data) return fail(res, 404, 'ADMIN_CHAT_NOT_FOUND', 'Conversation not found')
    const result = await supabase.from('admin_support_folder_members')
      .delete().eq('folder_id', folderId).eq('conversation_id', conversationId)
    if (result.error) throw result.error
    res.set('Cache-Control', 'no-store')
    return res.json({ ok: true })
  } catch (error) {
    return failed(res, error)
  }
})

export default router
