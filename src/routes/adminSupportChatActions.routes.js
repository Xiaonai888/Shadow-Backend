import express from 'express'
import { randomUUID, createHash } from 'node:crypto'
import { rateLimit } from 'express-rate-limit'
import { supabase } from '../config/supabase.js'
import { requireAdminPermission } from '../middleware/adminPermission.middleware.js'

const router = express.Router()
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const preAuthLimit = rateLimit({
  windowMs: 60_000,
  limit: 60,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { ok: false, code: 'ADMIN_SUPPORT_IP_RATE_LIMIT', message: 'Too many requests' },
})
const writeLimit = rateLimit({
  windowMs: 60_000,
  limit: 24,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req) => String(req.admin.admin_id),
  message: { ok: false, code: 'ADMIN_SUPPORT_WRITE_RATE_LIMIT', message: 'Too many chat actions' },
})
const reply = requireAdminPermission('admin_chat.reply')
const manage = requireAdminPermission('admin_chat.manage')

function fail(res, status, code, message) {
  return res.status(status).json({ ok: false, code, message })
}

function unavailable(res, error) {
  console.error('ADMIN_SUPPORT_ACTION_FAILED', error?.code || error?.message || 'UNKNOWN')
  return fail(res, 503, 'ADMIN_SUPPORT_ACTION_UNAVAILABLE', 'Support action is unavailable')
}

function rpcFailure(res, error) {
  const detail = String(error?.message || '').toLowerCase()
  if (detail.includes('archived') || detail.includes('not assigned') || detail.includes('already')) {
    return fail(res, 409, 'ADMIN_SUPPORT_CONFLICT', 'Conversation is archived, changed, or not assigned')
  }
  if (detail.includes('not found')) return fail(res, 404, 'ADMIN_SUPPORT_NOT_FOUND', 'Conversation not found')
  return unavailable(res, error)
}

function staffRestricted(admin, conversation) {
  return admin.role === 'staff' && conversation.assigned_admin_id !== admin.admin_id
}

async function getConversation(id) {
  const result = await supabase.from('admin_support_conversations')
    .select('id, reader_user_id, assigned_admin_id, status')
    .eq('id', id).maybeSingle()
  if (result.error) throw result.error
  return result.data
}

function publicIdentity(adminId) {
  const hash = createHash('sha256').update(String(adminId)).digest('hex').slice(0, 8).toUpperCase()
  return `S-${hash}`
}

router.post('/conversations/start', preAuthLimit, manage, writeLimit, async (req, res) => {
  const userId = req.body?.reader_user_id
  const content = req.body?.message
  if (typeof userId !== 'string' || !UUID.test(userId)) {
    return fail(res, 400, 'ADMIN_SUPPORT_INVALID_USER', 'Valid Reader ID is required')
  }
  if (typeof content !== 'string' || content.trim().length < 1 || content.trim().length > 2000) {
    return fail(res, 400, 'ADMIN_SUPPORT_INVALID_MESSAGE', 'Message must have 1–2000 characters')
  }
  if (req.admin.role === 'staff') {
    return fail(res, 403, 'ADMIN_SUPPORT_START_FORBIDDEN', 'Only an Admin can start a new support conversation')
  }
  const messageId = req.body?.request_id || randomUUID()
  if (!UUID.test(String(messageId))) {
    return fail(res, 400, 'ADMIN_SUPPORT_INVALID_REQUEST', 'Invalid request ID')
  }
  try {
    const { data, error } = await supabase.rpc('admin_support_send_message_v1', {
      p_reader_user_id: userId,
      p_sender_kind: 'admin',
      p_sender_admin_id: String(req.admin.admin_id),
      p_public_support_id: publicIdentity(req.admin.admin_id),
      p_message_text: content.trim(),
      p_message_id: messageId,
      p_conversation_id: null,
    })
    if (error) return rpcFailure(res, error)
    res.set('Cache-Control', 'no-store')
    return res.status(data?.created ? 201 : 200).json(data)
  } catch (error) {
    return unavailable(res, error)
  }
})

router.post('/conversations/:conversationId/messages', preAuthLimit, reply, writeLimit, async (req, res) => {
  const id = req.params.conversationId
  const content = req.body?.message
  if (!UUID.test(id)) return fail(res, 400, 'ADMIN_SUPPORT_INVALID_ID', 'Invalid conversation ID')
  if (typeof content !== 'string' || content.trim().length < 1 || content.trim().length > 2000) {
    return fail(res, 400, 'ADMIN_SUPPORT_INVALID_MESSAGE', 'Message must have 1–2000 characters')
  }
  const messageId = req.body?.request_id || randomUUID()
  if (!UUID.test(String(messageId))) return fail(res, 400, 'ADMIN_SUPPORT_INVALID_REQUEST', 'Invalid request ID')
  try {
    const conversation = await getConversation(id)
    if (!conversation) return fail(res, 404, 'ADMIN_SUPPORT_NOT_FOUND', 'Conversation not found')
    if (staffRestricted(req.admin, conversation)) {
      return fail(res, 403, 'ADMIN_SUPPORT_NOT_ASSIGNED', 'Conversation is assigned to another Admin')
    }
    if (conversation.status === 'archived') {
      return fail(res, 409, 'ADMIN_SUPPORT_ARCHIVED', 'Restore the archived chat before replying')
    }
    const { data, error } = await supabase.rpc('admin_support_send_message_v1', {
      p_reader_user_id: conversation.reader_user_id,
      p_sender_kind: 'admin',
      p_sender_admin_id: String(req.admin.admin_id),
      p_public_support_id: publicIdentity(req.admin.admin_id),
      p_message_text: content.trim(),
      p_message_id: messageId,
      p_conversation_id: id,
    })
    if (error) return rpcFailure(res, error)
    res.set('Cache-Control', 'no-store')
    return res.status(data?.created ? 201 : 200).json(data)
  } catch (error) {
    return unavailable(res, error)
  }
})

router.patch('/conversations/:conversationId/action', preAuthLimit, manage, writeLimit, async (req, res) => {
  const id = req.params.conversationId
  const action = req.body?.action
  const supported = new Set(['read', 'archive', 'restore', 'priority', 'assign', 'country', 'note'])
  if (!UUID.test(id)) return fail(res, 400, 'ADMIN_SUPPORT_INVALID_ID', 'Invalid conversation ID')
  if (!supported.has(action)) return fail(res, 400, 'ADMIN_SUPPORT_INVALID_ACTION', 'Unsupported action')
  if (action === 'assign' && !req.admin.has_all_permissions && !req.admin.permission_keys?.includes('admin_chat.assign')) {
    return fail(res, 403, 'ADMIN_SUPPORT_ASSIGN_FORBIDDEN', 'Assign permission required')
  }
  if (action === 'assign' && req.admin.role === 'staff') {
    return fail(res, 403, 'ADMIN_SUPPORT_ASSIGN_FORBIDDEN', 'Only an Admin can assign conversations')
  }
  const value = req.body?.value
  if (value !== undefined && value !== null && typeof value !== 'string') {
    return fail(res, 400, 'ADMIN_SUPPORT_INVALID_VALUE', 'Value must be text')
  }
  if (typeof value === 'string' && value.length > 10000) {
    return fail(res, 400, 'ADMIN_SUPPORT_INVALID_VALUE', 'Value is too long')
  }
  try {
    const conversation = await getConversation(id)
    if (!conversation) return fail(res, 404, 'ADMIN_SUPPORT_NOT_FOUND', 'Conversation not found')
    if (staffRestricted(req.admin, conversation)) {
      return fail(res, 403, 'ADMIN_SUPPORT_NOT_ASSIGNED', 'Conversation is assigned to another Admin')
    }
    const { data, error } = await supabase.rpc('admin_support_update_conversation_v1', {
      p_conversation_id: id,
      p_admin_id: String(req.admin.admin_id),
      p_action: action,
      p_value: value ?? null,
    })
    if (error) return rpcFailure(res, error)
    res.set('Cache-Control', 'no-store')
    return res.json(data)
  } catch (error) {
    return unavailable(res, error)
  }
})

export default router
