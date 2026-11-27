import express from 'express'
import { rateLimit } from 'express-rate-limit'
import { supabase } from '../config/supabase.js'
import { requireAdminPermission } from '../middleware/adminPermission.middleware.js'
import { getDeletedSupportContent } from '../services/supportDeletedContent.service.js'
import { getPrivateSupportImageReadUrl } from '../services/supportChatPrivateR2.service.js'

export const adminSupportDeletedContentRoutes = express.Router()
const options = { windowMs: 60000, standardHeaders: 'draft-8', legacyHeaders: false,
  message: { ok: false, code: 'SUPPORT_DELETED_RATE_LIMIT', message: 'Too many requests' } }
const ipLimit = rateLimit({ ...options, limit: 60 })
const adminLimit = rateLimit({ ...options, limit: 24, keyGenerator: req => String(req.admin.admin_id) })

adminSupportDeletedContentRoutes.get('/conversations/:conversationId/messages/:messageId/deleted-content', ipLimit, requireAdminPermission('admin_chat.view'), adminLimit, async (req, res) => {
  res.set('Cache-Control', 'private, no-store')
  try {
    const result = await getDeletedSupportContent({ db: supabase, signImage: getPrivateSupportImageReadUrl, admin: req.admin, conversationId: req.params.conversationId, messageId: req.params.messageId })
    return res.json(result)
  } catch (error) {
    const known = [400, 403, 404].includes(error?.statusCode) && ['SUPPORT_DELETED_INVALID_ID', 'SUPPORT_DELETED_FORBIDDEN', 'SUPPORT_DELETED_NOT_FOUND'].includes(error?.code)
    if (!known) console.error('SUPPORT_DELETED_CONTENT_READ_FAILED')
    const code = known ? error.code : 'SUPPORT_DELETED_UNAVAILABLE'
    return res.status(known ? error.statusCode : 503).json({ ok: false, code, message: code })
  }
})
