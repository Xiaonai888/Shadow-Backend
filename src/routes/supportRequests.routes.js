import express from 'express'
import { rateLimit } from 'express-rate-limit'
import multer from 'multer'
import os from 'node:os'
import { unlink } from 'node:fs/promises'
import { requireAdmin } from '../middleware/auth.middleware.js'
import { requireUser } from '../middleware/user.middleware.js'
import {
  createSupportRequest,
  deleteAdminSupportRequest,
  getAdminSupportRequest,
  getMySupportRequest,
  listAdminSupportRequests,
  listMySupportRequests,
  streamSupportScreenshot,
  updateAdminSupportRequest,
} from '../controllers/supportRequests.controller.js'
import path from 'node:path'

const router = express.Router()
const supportScreenshotLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 180,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
})
const supportReadLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req) => String(req.user?.user_id || req.user?.id || req.user?.session_id || 'unauthenticated'),
})
const supportCreateLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req) => String(req.user?.user_id || req.user?.id || req.user?.session_id || 'unauthenticated'),
})
const supportAdminReadLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req) => String(req.admin?.admin_id || req.admin?.id || req.admin?.user_id || req.admin?.sub || 'unauthenticated'),
})
const supportAdminWriteLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req) => String(req.admin?.admin_id || req.admin?.id || req.admin?.user_id || req.admin?.sub || 'unauthenticated'),
})

const supportAdminDeletePreAuthLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
})

const supportAdminPreAuthLimit = rateLimit({ windowMs: 60000, limit: 600, standardHeaders: 'draft-8', legacyHeaders: false })
const allowedTypes = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
])

const upload = multer({
  dest: os.tmpdir(),
  limits: {
    fileSize: 2 * 1024 * 1024,
    files: 1,
  },
  fileFilter(req, file, callback) {
    if (allowedTypes.has(file.mimetype)) {
      return callback(null, true)
    }

    const error = new Error(
      'Only JPEG, PNG, WEBP, or GIF screenshots are allowed'
    )
    error.statusCode = 400
    return callback(error)
  },
})

async function removeTempFile(req) {
  const fileName = req.file?.filename
  if (typeof fileName !== 'string' || !/^[a-f0-9]{32}$/i.test(fileName)) return
  const expectedPath = path.join(os.tmpdir(), fileName)
  if (req.file.path !== expectedPath) return
  await unlink(expectedPath).catch(() => {})
}
function cleanupTempFile(req, res, next) {
  let cleaned = false

  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    removeTempFile(req).catch(() => {})
  }

  res.once('finish', cleanup)
  res.once('close', cleanup)
  next()
}

function uploadScreenshot(req, res, next) {
  upload.single('screenshot')(req, res, (error) => {
    if (!error) return next()

    removeTempFile(req).catch(() => {})

    const message =
      error.code === 'LIMIT_FILE_SIZE'
        ? 'Screenshot must be 2 MB or smaller'
        : error.message || 'Invalid screenshot'

    return res
      .status(error.statusCode || 400)
      .json({
        ok: false,
        message,
      })
  })
}

router.get(
  '/screenshot/:requestId',
  supportScreenshotLimit,
  streamSupportScreenshot
)

router.post(
  '/requests',
  requireUser,
  supportCreateLimit,
  uploadScreenshot,
  cleanupTempFile,
  createSupportRequest
)

router.get(
  '/requests',
  requireUser,
  supportReadLimit,
  listMySupportRequests
)

router.get(
  '/requests/:requestId',
  requireUser,
  supportReadLimit,
  getMySupportRequest
)

router.get(
  '/admin/requests',
  supportAdminPreAuthLimit,
  requireAdmin,
  supportAdminReadLimit,
  listAdminSupportRequests
)

router.get(
  '/admin/requests/:requestId',
  supportAdminPreAuthLimit,
  requireAdmin,
  supportAdminReadLimit,
  getAdminSupportRequest
)

router.patch(
  '/admin/requests/:requestId',
  supportAdminPreAuthLimit,
  requireAdmin,
  supportAdminWriteLimit,
  updateAdminSupportRequest
)

router.delete(
  '/admin/requests/:requestId',
  supportAdminPreAuthLimit,
  supportAdminDeletePreAuthLimit,
  requireAdmin,
  supportAdminWriteLimit,
  deleteAdminSupportRequest
)

export default router
