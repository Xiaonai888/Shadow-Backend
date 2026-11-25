import express from 'express'
import { rateLimit } from 'express-rate-limit'
import { supabase } from '../config/supabase.js'
import { requireAdminPermission } from '../middleware/adminPermission.middleware.js'
import { requireUser } from '../middleware/user.middleware.js'
import * as r2 from '../services/supportChatPrivateR2.service.js'
import { initSupportImage, finalizeSupportImage, getSupportImageView } from '../services/supportChatImageMessages.service.js'
import { supportImageActor } from '../services/supportChatImageToken.service.js'
import { notifyReaderSupportMessage } from '../services/adminSupportNotificationEvents.service.js'

export const adminSupportImagesRoutes = express.Router()
export const readerSupportImagesRoutes = express.Router()

function limiter(limit, identity) {
  return rateLimit({ windowMs: 60000, limit, standardHeaders: 'draft-8', legacyHeaders: false, ...(identity ? { keyGenerator: identity } : {}), message: { ok: false, code: 'SUPPORT_IMAGE_RATE_LIMIT', message: 'Too many image requests' } })
}
const ipLimit = limiter(100)
const adminWrite = limiter(16, req => String(req.admin.admin_id))
const readerWrite = limiter(8, req => String(req.user.user_id))
const adminRead = limiter(60, req => String(req.admin.admin_id))
const readerRead = limiter(60, req => String(req.user.user_id))
const reply = requireAdminPermission('admin_chat.reply')
const view = requireAdminPermission('admin_chat.view')

function failure(error) {
  const code = String(error?.code || '')
  if (/^SUPPORT_(IMAGE_[A-Z_]+|CHAT_BLOCKED)$/.test(code) && [400, 403, 404, 409, 413].includes(error.statusCode)) return { status: error.statusCode, code }
  const message = String(error?.message || '').toLowerCase()
  if (message.includes('support_chat_blocked')) return { status: 403, code: 'SUPPORT_CHAT_BLOCKED' }
  if (message.includes('archived')) return { status: 409, code: 'SUPPORT_IMAGE_ARCHIVED' }
  if (message.includes('request conflict') || code === '23505') return { status: 409, code: 'SUPPORT_IMAGE_REQUEST_CONFLICT' }
  if (message.includes('not found') || error?.name === 'NotFound' || error?.name === 'NoSuchKey') return { status: 404, code: 'SUPPORT_IMAGE_NOT_FOUND' }
  if (message.includes('invalid support image')) return { status: 400, code: 'SUPPORT_IMAGE_INVALID' }
  return { status: 503, code: 'SUPPORT_IMAGE_UNAVAILABLE' }
}

function handle(kind, operation) {
  return async (req, res) => {
    res.set('Cache-Control', 'no-store')
    try {
      const actor = kind === 'admin' ? supportImageActor(kind, req.admin.admin_id, req.admin.role) : supportImageActor(kind, req.user.user_id)
      const conversationId = kind === 'admin' ? req.params.conversationId : null
      const args = [supabase, r2, actor, conversationId]
      if (operation === 'init') return res.status(201).json(await initSupportImage(...args, req.body))
      if (operation === 'view') return res.json(await getSupportImageView(...args, req.params.messageId))
      const result = await finalizeSupportImage(...args, req.body)
      if (kind === 'reader' && result.created) void notifyReaderSupportMessage(supabase, result, actor.id).catch(() => {})
      return res.status(result.created ? 201 : 200).json(result)
    } catch (error) {
      const result = failure(error)
      if (result.status === 503) console.error('SUPPORT_IMAGE_FAILED', operation, error?.code || error?.name || 'UNKNOWN')
      return res.status(result.status).json({ ok: false, code: result.code, message: result.code })
    }
  }
}

adminSupportImagesRoutes.post('/conversations/:conversationId/images/init', ipLimit, reply, adminWrite, handle('admin', 'init'))
adminSupportImagesRoutes.post('/conversations/:conversationId/images/finalize', ipLimit, reply, adminWrite, handle('admin', 'finalize'))
adminSupportImagesRoutes.get('/conversations/:conversationId/messages/:messageId/image', ipLimit, view, adminRead, handle('admin', 'view'))
readerSupportImagesRoutes.post('/mine/images/init', ipLimit, requireUser, readerWrite, handle('reader', 'init'))
readerSupportImagesRoutes.post('/mine/images/finalize', ipLimit, requireUser, readerWrite, handle('reader', 'finalize'))
readerSupportImagesRoutes.get('/mine/messages/:messageId/image', ipLimit, requireUser, readerRead, handle('reader', 'view'))
