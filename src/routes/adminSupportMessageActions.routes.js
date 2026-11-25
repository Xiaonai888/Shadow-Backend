import express from 'express'
import { createHash } from 'node:crypto'
import { rateLimit } from 'express-rate-limit'
import { supabase } from '../config/supabase.js'
import { requireAdminPermission } from '../middleware/adminPermission.middleware.js'
import { parseSupportMessageAction, supportMessageActionError } from '../services/adminSupportMessageActionInput.service.js'

const router = express.Router()
const preAuthLimit = rateLimit({
  windowMs: 60000,
  limit: 60,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { ok: false, code: 'ADMIN_SUPPORT_MESSAGE_IP_LIMIT', message: 'Too many requests' },
})
const writeLimit = rateLimit({
  windowMs: 60000,
  limit: 24,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: req => String(req.admin.admin_id),
  message: { ok: false, code: 'ADMIN_SUPPORT_MESSAGE_WRITE_LIMIT', message: 'Too many message actions' },
})
const canReply = requireAdminPermission('admin_chat.reply')

function handle(action) {
  return async (req, res) => {
    res.set('Cache-Control', 'no-store')
    const input = parseSupportMessageAction(req.params, req.body, action)
    if (!input) return res.status(400).json({ ok: false, code: 'ADMIN_SUPPORT_MESSAGE_INVALID', message: 'Invalid message action' })
    const adminId = String(req.admin.admin_id)
    try {
      let result
      if (action === 'reply') {
        const publicId = `S-${createHash('sha256').update(adminId).digest('hex').slice(0, 8).toUpperCase()}`
        result = await supabase.rpc('admin_support_admin_reply_v1', {
          p_conversation_id: input.conversationId,
          p_admin_id: adminId,
          p_public_support_id: publicId,
          p_message_text: input.text,
          p_message_id: input.requestId,
          p_reply_to_message_id: input.messageId,
        })
      } else {
        result = await supabase.rpc('admin_support_admin_message_action_v1', {
          p_conversation_id: input.conversationId,
          p_admin_id: adminId,
          p_message_id: input.messageId,
          p_action: action,
          p_message_text: input.text ?? null,
        })
      }
      if (result.error) throw result.error
      if (result.data?.ok !== true) throw new Error('Invalid RPC response')
      return res.status(action === 'reply' && result.data.created === true ? 201 : 200).json(result.data)
    } catch (error) {
      const failure = supportMessageActionError(error)
      if (failure.status === 503) console.error('ADMIN_SUPPORT_MESSAGE_ACTION_FAILED', error?.code || 'UNKNOWN')
      return res.status(failure.status).json({ ok: false, code: failure.code, message: failure.message })
    }
  }
}

router.patch('/conversations/:conversationId/messages/:messageId', preAuthLimit, canReply, writeLimit, handle('edit'))
router.delete('/conversations/:conversationId/messages/:messageId', preAuthLimit, canReply, writeLimit, handle('delete'))
router.post('/conversations/:conversationId/messages/:messageId/reply', preAuthLimit, canReply, writeLimit, handle('reply'))

export default router
