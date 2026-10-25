import express from 'express'
import { randomUUID } from 'node:crypto'
import { rateLimit } from 'express-rate-limit'
import { supabase } from '../config/supabase.js'
import { requireUser } from '../middleware/user.middleware.js'

const router = express.Router()
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const preAuthLimit = rateLimit({
  windowMs: 60_000,
  limit: 80,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { ok: false, code: 'READER_SUPPORT_IP_RATE_LIMIT', message: 'Too many requests' },
})
const readLimit = rateLimit({
  windowMs: 60_000,
  limit: 45,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req) => String(req.user.user_id),
  message: { ok: false, code: 'READER_SUPPORT_READ_RATE_LIMIT', message: 'Too many requests' },
})
const writeLimit = rateLimit({
  windowMs: 60_000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req) => String(req.user.user_id),
  message: { ok: false, code: 'READER_SUPPORT_WRITE_RATE_LIMIT', message: 'Too many messages' },
})

function problem(res, status, code, message) {
  return res.status(status).json({ ok: false, code, message })
}

function unavailable(res, error) {
  console.error('READER_SUPPORT_FAILED', error?.code || error?.message || 'UNKNOWN')
  return problem(res, 503, 'READER_SUPPORT_UNAVAILABLE', 'Support chat is temporarily unavailable')
}

async function getOwnConversation(userId) {
  const result = await supabase.from('admin_support_conversations')
    .select('id, reader_user_id, status, last_message_at, last_message_preview, unread_for_reader, created_at')
    .eq('reader_user_id', userId).maybeSingle()
  if (result.error) throw result.error
  return result.data
}

router.get('/mine', preAuthLimit, requireUser, readLimit, async (req, res) => {
  try {
    const conversation = await getOwnConversation(req.user.user_id)
    res.set('Cache-Control', 'no-store')
    return res.json({ ok: true, conversation })
  } catch (error) {
    return unavailable(res, error)
  }
})

router.get('/mine/messages', preAuthLimit, requireUser, readLimit, async (req, res) => {
  const before = req.query.before
  if (before !== undefined && (typeof before !== 'string' || before.length > 50 || !Number.isFinite(Date.parse(before)))) {
    return problem(res, 400, 'READER_SUPPORT_BAD_CURSOR', 'Invalid message cursor')
  }
  try {
    const conversation = await getOwnConversation(req.user.user_id)
    if (!conversation) return res.json({ ok: true, messages: [], limit: 20, has_more: false, next_before: null })
    let query = supabase.from('admin_support_messages')
      .select('id, sender_kind, public_support_id, message_text, attachments, seen_at, created_at')
      .eq('conversation_id', conversation.id)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
    if (before) query = query.lt('created_at', new Date(before).toISOString())
    const { data, error } = await query.limit(21)
    if (error) throw error
    const page = (data || []).slice(0, 20)
    res.set('Cache-Control', 'no-store')
    return res.json({
      ok: true,
      conversation_id: conversation.id,
      messages: page.reverse(),
      limit: 20,
      has_more: (data || []).length > 20,
      next_before: page.length ? page[0].created_at : null,
    })
  } catch (error) {
    return unavailable(res, error)
  }
})

router.post('/mine/messages', preAuthLimit, requireUser, writeLimit, async (req, res) => {
  const message = req.body?.message
  if (typeof message !== 'string' || message.trim().length < 1 || message.trim().length > 2000) {
    return problem(res, 400, 'READER_SUPPORT_BAD_MESSAGE', 'Message must contain 1–2000 characters')
  }
  const requestId = req.body?.request_id || randomUUID()
  if (!UUID.test(String(requestId))) {
    return problem(res, 400, 'READER_SUPPORT_BAD_REQUEST_ID', 'Invalid message request ID')
  }
  try {
    const { data, error } = await supabase.rpc('admin_support_send_message_v1', {
      p_reader_user_id: req.user.user_id,
      p_sender_kind: 'reader',
      p_sender_admin_id: null,
      p_public_support_id: null,
      p_message_text: message.trim(),
      p_message_id: requestId,
      p_conversation_id: null,
    })
    if (error) {
      if (String(error.message || '').toLowerCase().includes('archived')) {
        return problem(res, 409, 'READER_SUPPORT_ARCHIVED', 'This support chat is archived')
      }
      return unavailable(res, error)
    }
    res.set('Cache-Control', 'no-store')
    return res.status(data?.created ? 201 : 200).json(data)
  } catch (error) {
    return unavailable(res, error)
  }
})

router.patch('/mine/read', preAuthLimit, requireUser, writeLimit, async (req, res) => {
  try {
    const { error } = await supabase.from('admin_support_conversations')
      .update({ unread_for_reader: 0 })
      .eq('reader_user_id', req.user.user_id)
    if (error) throw error
    res.set('Cache-Control', 'no-store')
    return res.json({ ok: true })
  } catch (error) {
    return unavailable(res, error)
  }
})

export default router
