import express from 'express'
import { rateLimit } from 'express-rate-limit'
import { supabase } from '../config/supabase.js'
import { requireAdminPermission } from '../middleware/adminPermission.middleware.js'
import { requireUser } from '../middleware/user.middleware.js'
import { publishAdminSupportNotificationChanged } from '../services/adminSupportNotificationSse.service.js'
import { markSupportSeen, parseSupportSeenInput, supportSeenError } from '../services/adminSupportSeen.service.js'

export const adminSupportSeenRoutes = express.Router()
export const readerSupportSeenRoutes = express.Router()

const options = { windowMs: 60000, standardHeaders: 'draft-8', legacyHeaders: false,
  message: { ok: false, code: 'SUPPORT_SEEN_RATE_LIMIT', message: 'Too many seen requests' } }
const adminIpLimit = rateLimit({ ...options, limit: 60 })
const readerIpLimit = rateLimit({ ...options, limit: 80 })
const adminLimit = rateLimit({ ...options, limit: 24, keyGenerator: req => String(req.admin.admin_id) })
const readerLimit = rateLimit({ ...options, limit: 20, keyGenerator: req => String(req.user.user_id) })

function handle(kind) {
  return async (req, res) => {
    res.set('Cache-Control', 'no-store')
    const actorId = kind === 'admin' ? String(req.admin.admin_id) : req.user.user_id
    const input = parseSupportSeenInput(kind, actorId, req.params.conversationId, req.body)
    if (!input) return res.status(400).json({ ok: false, code: 'SUPPORT_SEEN_INVALID', message: 'Invalid seen request' })
    try {
      return res.json(await markSupportSeen(supabase, input, publishAdminSupportNotificationChanged))
    } catch (error) {
      const failure = supportSeenError(error)
      if (failure.status === 503) console.error('SUPPORT_SEEN_FAILED', kind, error?.code || 'UNKNOWN')
      return res.status(failure.status).json({ ok: false, code: failure.code, message: failure.message })
    }
  }
}

adminSupportSeenRoutes.patch('/conversations/:conversationId/seen', adminIpLimit, requireAdminPermission('admin_chat.manage'), adminLimit, handle('admin'))
readerSupportSeenRoutes.patch('/mine/seen', readerIpLimit, requireUser, readerLimit, handle('reader'))
