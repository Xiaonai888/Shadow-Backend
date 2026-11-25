import express from 'express'
import { rateLimit } from 'express-rate-limit'
import { supabase } from '../config/supabase.js'
import { requireAdminPermission } from '../middleware/adminPermission.middleware.js'
import { requireUser } from '../middleware/user.middleware.js'
import { getAdminSupportBlock, getReaderSupportBlock, setAdminSupportBlock, parseSupportBlockInput, supportBlockError } from '../services/adminSupportBlock.service.js'

export const adminSupportBlockRoutes = express.Router()
export const readerSupportBlockRoutes = express.Router()

const options = { windowMs: 60000, standardHeaders: 'draft-8', legacyHeaders: false,
  message: { ok: false, code: 'SUPPORT_BLOCK_RATE_LIMIT', message: 'Too many requests' } }
const adminIpLimit = rateLimit({ ...options, limit: 60 })
const readerIpLimit = rateLimit({ ...options, limit: 60 })
const adminReadLimit = rateLimit({ ...options, limit: 24, keyGenerator: req => String(req.admin.admin_id) })
const adminWriteLimit = rateLimit({ ...options, limit: 8, keyGenerator: req => String(req.admin.admin_id) })
const readerReadLimit = rateLimit({ ...options, limit: 24, keyGenerator: req => String(req.user.user_id) })

function respondError(res, error) {
  const failure = supportBlockError(error)
  if (failure.status === 503) console.error('SUPPORT_BLOCK_FAILED', error?.code || 'UNKNOWN')
  return res.status(failure.status).json({ ok: false, code: failure.code, message: failure.message })
}

function ownerOnly(req, res, next) {
  if (req.admin?.role !== 'owner') return respondError(res, new Error('Support block owner required'))
  return next()
}

adminSupportBlockRoutes.get('/conversations/:conversationId/block', adminIpLimit, requireAdminPermission('admin_chat.view'), adminReadLimit, async (req, res) => {
  res.set('Cache-Control', 'no-store')
  try {
    return res.json(await getAdminSupportBlock(supabase, req.admin, req.params.conversationId))
  } catch (error) {
    return respondError(res, error)
  }
})

adminSupportBlockRoutes.patch('/conversations/:conversationId/block', adminIpLimit, requireAdminPermission('admin_chat.manage'), ownerOnly, adminWriteLimit, async (req, res) => {
  res.set('Cache-Control', 'no-store')
  const input = parseSupportBlockInput({ ...req.admin, admin_id: String(req.admin.admin_id) }, req.params.conversationId, req.body)
  if (!input) return respondError(res, new Error('Invalid support block input'))
  try {
    return res.json(await setAdminSupportBlock(supabase, input))
  } catch (error) {
    return respondError(res, error)
  }
})

readerSupportBlockRoutes.get('/mine/block', readerIpLimit, requireUser, readerReadLimit, async (req, res) => {
  res.set('Cache-Control', 'no-store')
  try {
    return res.json(await getReaderSupportBlock(supabase, req.user.user_id))
  } catch (error) {
    return respondError(res, error)
  }
})
