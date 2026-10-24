import express from 'express'
import { ipKeyGenerator, rateLimit } from 'express-rate-limit'
import { requireAdminPermission } from '../middleware/adminPermission.middleware.js'
import { requireUser } from '../middleware/user.middleware.js'
import {
  createAdminProfileFrame,
  deleteAdminProfileFrame,
  getReaderProfileFrameSelection,
  listAdminProfileFrames,
  listReaderProfileFrames,
  setReaderProfileFrameSelection,
  updateAdminProfileFrame,
} from '../controllers/profileFrames.controller.js'

export const adminProfileFramesRouter = express.Router()
export const readerProfileFramesRouter = express.Router()

function limiter({ windowMs = 60 * 1000, limit, code, message, keyGenerator }) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    ...(keyGenerator ? { keyGenerator } : {}),
    message: { ok: false, code, message },
  })
}
function createIpLimiter(options) {
  return limiter({ ...options, keyGenerator: undefined })
}

const adminKey = req => String(
  req.admin?.admin_id ||
  req.admin?.id ||
  req.admin?.sub ||
  req.admin?.email ||
  ipKeyGenerator(req.ip)
)

const readerKey = req => String(
  req.user?.user_id ||
  req.user?.id ||
  ipKeyGenerator(req.ip)
)

const adminReadIp = limiter({
  limit: 120,
  code: 'PROFILE_FRAMES_ADMIN_READ_IP_LIMIT',
  message: 'Too many frame catalog requests. Please retry shortly.',
})

const adminWriteIp = limiter({
  limit: 45,
  code: 'PROFILE_FRAMES_ADMIN_WRITE_IP_LIMIT',
  message: 'Too many frame changes. Please retry shortly.',
})

const adminReadAccount = limiter({
  limit: 90,
  code: 'PROFILE_FRAMES_ADMIN_READ_LIMIT',
  message: 'Frame catalog request limit reached. Please retry shortly.',
  keyGenerator: adminKey,
})

const adminWriteAccount = limiter({
  limit: 20,
  code: 'PROFILE_FRAMES_ADMIN_WRITE_LIMIT',
  message: 'Frame change limit reached. Please retry shortly.',
  keyGenerator: adminKey,
})

const readerCatalogIp = limiter({
  limit: 180,
  code: 'PROFILE_FRAMES_READER_CATALOG_IP_LIMIT',
  message: 'Too many frame requests. Please retry shortly.',
})

const readerSelectionIp = limiter({
  limit: 90,
  code: 'PROFILE_FRAMES_READER_SELECTION_IP_LIMIT',
  message: 'Too many frame selection requests. Please retry shortly.',
})

const readerApplyIp = limiter({
  limit: 45,
  code: 'PROFILE_FRAMES_READER_APPLY_IP_LIMIT',
  message: 'Too many frame updates. Please retry shortly.',
})

const readerCatalogAccount = limiter({
  limit: 120,
  code: 'PROFILE_FRAMES_READER_CATALOG_LIMIT',
  message: 'Frame catalog request limit reached. Please retry shortly.',
  keyGenerator: readerKey,
})

const readerSelectionAccount = limiter({
  limit: 60,
  code: 'PROFILE_FRAMES_READER_SELECTION_LIMIT',
  message: 'Frame selection request limit reached. Please retry shortly.',
  keyGenerator: readerKey,
})

const readerApplyAccount = limiter({
  limit: 15,
  code: 'PROFILE_FRAMES_READER_APPLY_LIMIT',
  message: 'Frame update limit reached. Please retry shortly.',
  keyGenerator: readerKey,
})

function optionalReaderSession(req, res, next) {
  if (!req.headers.authorization) return next()
  return requireUser(req, res, next)
}

adminProfileFramesRouter.get(
  '/',
  adminReadIp,
  requireAdminPermission('media_library.view'),
  adminReadAccount,
  listAdminProfileFrames
)

adminProfileFramesRouter.post(
  '/',
  adminWriteIp,
  requireAdminPermission('media_library.manage'),
  adminWriteAccount,
  createAdminProfileFrame
)

adminProfileFramesRouter.patch(
  '/:frameId',
  adminWriteIp,
  requireAdminPermission('media_library.manage'),
  adminWriteAccount,
  updateAdminProfileFrame
)

adminProfileFramesRouter.delete(
  '/:frameId',
  adminWriteIp,
  requireAdminPermission('media_library.manage'),
  adminWriteAccount,
  deleteAdminProfileFrame
)

readerProfileFramesRouter.get(
  '/',
  readerCatalogIp,
  optionalReaderSession,
  readerCatalogAccount,
  listReaderProfileFrames
)

readerProfileFramesRouter.get(
  '/selection',
  readerSelectionIp,
  requireUser,
  readerSelectionAccount,
  getReaderProfileFrameSelection
)

readerProfileFramesRouter.put(
  '/selection',
  readerApplyIp,
  requireUser,
  readerApplyAccount,
  setReaderProfileFrameSelection
)
