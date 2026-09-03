import express from 'express'
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

const router = express.Router()
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
  if (!req.file?.path) return
  await unlink(req.file.path).catch(() => {})
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
  streamSupportScreenshot
)

router.post(
  '/requests',
  requireUser,
  uploadScreenshot,
  cleanupTempFile,
  createSupportRequest
)

router.get(
  '/requests',
  requireUser,
  listMySupportRequests
)

router.get(
  '/requests/:requestId',
  requireUser,
  getMySupportRequest
)

router.get(
  '/admin/requests',
  requireAdmin,
  listAdminSupportRequests
)

router.get(
  '/admin/requests/:requestId',
  requireAdmin,
  getAdminSupportRequest
)

router.patch(
  '/admin/requests/:requestId',
  requireAdmin,
  updateAdminSupportRequest
)

router.delete(
  '/admin/requests/:requestId',
  requireAdmin,
  deleteAdminSupportRequest
)

export default router
