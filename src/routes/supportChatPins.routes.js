import express from 'express'
import { rateLimit } from 'express-rate-limit'
import { supabase } from '../config/supabase.js'
import { requireUser } from '../middleware/user.middleware.js'
import { requireAdminPermission } from '../middleware/adminPermission.middleware.js'
import { parseSupportPinInput, runSupportPin, supportPinError } from '../services/supportChatPins.service.js'

export const readerSupportPinsRoutes = express.Router()
export const adminSupportPinsRoutes = express.Router()
const options = { windowMs: 60000, standardHeaders: 'draft-8', legacyHeaders: false,
  message: { ok: false, code: 'SUPPORT_PIN_RATE_LIMIT' } }
const ipLimit = rateLimit({ ...options, limit: 60 })
const readerLimit = rateLimit({ ...options, limit: 24, keyGenerator: req => String(req.user.user_id) })
const adminLimit = rateLimit({ ...options, limit: 24, keyGenerator: req => String(req.admin.admin_id) })
const adminView = requireAdminPermission('admin_chat.view')
const adminReply = requireAdminPermission('admin_chat.reply')

function handle(kind, action) {
  return async (req, res) => {
    res.set('Cache-Control', 'no-store')
    const actorId = kind === 'reader' ? req.user.user_id : String(req.admin.admin_id)
    const input = parseSupportPinInput(kind, actorId, req.params.conversationId, action, req.params.messageId)
    if (!input) return res.status(400).json({ ok: false, code: 'SUPPORT_PIN_INVALID' })
    try {
      return res.json(await runSupportPin(supabase, input))
    } catch (error) {
      const failure = supportPinError(error)
      if (failure.status === 503) console.error('SUPPORT_PIN_FAILED', kind, action, error?.code || 'UNKNOWN')
      return res.status(failure.status).json({ ok: false, code: failure.code })
    }
  }
}

readerSupportPinsRoutes.get('/mine/pins', ipLimit, requireUser, readerLimit, handle('reader', 'list'))
readerSupportPinsRoutes.post('/mine/messages/:messageId/pin', ipLimit, requireUser, readerLimit, handle('reader', 'pin'))
readerSupportPinsRoutes.delete('/mine/messages/:messageId/pin', ipLimit, requireUser, readerLimit, handle('reader', 'unpin'))
adminSupportPinsRoutes.get('/conversations/:conversationId/pins', ipLimit, adminView, adminLimit, handle('admin', 'list'))
adminSupportPinsRoutes.post('/conversations/:conversationId/messages/:messageId/pin', ipLimit, adminReply, adminLimit, handle('admin', 'pin'))
adminSupportPinsRoutes.delete('/conversations/:conversationId/messages/:messageId/pin', ipLimit, adminReply, adminLimit, handle('admin', 'unpin'))
