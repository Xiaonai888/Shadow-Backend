import express from 'express'
import multer from 'multer'
import os from 'node:os'
import { unlink } from 'node:fs/promises'
import { requireAdmin } from '../middleware/auth.middleware.js'
import { guardDiskBackedUploads } from '../middleware/globalMediaUploadGuard.middleware.js'
import {
  createAdminBrush,
  deleteAdminBrush,
  getAdminApp,
  removeAdminAppProfile,
  removeAdminBrushThumbnail,
  replaceAdminBrushFile,
  replaceAdminBrushThumbnail,
  updateAdminApp,
  updateAdminBrush,
  uploadAdminAppProfile,
} from '../controllers/appSettings.controller.js'

const router = express.Router()
const IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/avif',
])

const upload = multer({
  dest: os.tmpdir(),
  limits: {
    fileSize: 25 * 1024 * 1024,
    files: 2,
  },
  fileFilter(req, file, callback) {
    const extension = String(file.originalname || '')
      .split('.')
      .pop()
      ?.toLowerCase()

    if (
      file.fieldname === 'brushFile' &&
      (IMAGE_TYPES.has(file.mimetype) || extension === 'abr')
    ) {
      return callback(null, true)
    }

    if (
      ['profile', 'thumbnail'].includes(file.fieldname) &&
      IMAGE_TYPES.has(file.mimetype)
    ) {
      return callback(null, true)
    }

    const error = new Error('Unsupported upload file')
    error.statusCode = 400
    return callback(error)
  },
})

async function removeTempFiles(req) {
  const files = [
    ...(req.file ? [req.file] : []),
    ...Object.values(req.files || {}).flat(),
  ]

  await Promise.all(
    files
      .filter((file) => file?.path)
      .map((file) => unlink(file.path).catch(() => {}))
  )
}

function cleanupTempFiles(req, res, next) {
  let cleaned = false

  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    removeTempFiles(req).catch(() => {})
  }

  res.once('finish', cleanup)
  res.once('close', cleanup)
  next()
}

function uploadError(req, res, error) {
  removeTempFiles(req).catch(() => {})

  return res.status(error.statusCode || 400).json({
    ok: false,
    message:
      error.code === 'LIMIT_FILE_SIZE'
        ? 'Each upload must be 25 MB or smaller'
        : error.message || 'Invalid upload',
  })
}

function runSingle(fieldName) {
  return (req, res, next) => {
    upload.single(fieldName)(req, res, (error) => {
      if (error) return uploadError(req, res, error)
      return next()
    })
  }
}

function runBrushFiles(req, res, next) {
  upload.fields([
    { name: 'brushFile', maxCount: 1 },
    { name: 'thumbnail', maxCount: 1 },
  ])(req, res, (error) => {
    if (error) return uploadError(req, res, error)
    return next()
  })
}

router.get('/:appKey', requireAdmin, getAdminApp)
router.patch('/:appKey', requireAdmin, updateAdminApp)

router.post(
  '/:appKey/profile',
  requireAdmin,
  runSingle('profile'),
  cleanupTempFiles,
  guardDiskBackedUploads,
  uploadAdminAppProfile
)

router.delete(
  '/:appKey/profile',
  requireAdmin,
  removeAdminAppProfile
)

router.post(
  '/:appKey/brushes',
  requireAdmin,
  runBrushFiles,
  cleanupTempFiles,
  guardDiskBackedUploads,
  createAdminBrush
)

router.patch(
  '/:appKey/brushes/:brushId',
  requireAdmin,
  updateAdminBrush
)

router.post(
  '/:appKey/brushes/:brushId/file',
  requireAdmin,
  runBrushFiles,
  cleanupTempFiles,
  guardDiskBackedUploads,
  replaceAdminBrushFile
)

router.post(
  '/:appKey/brushes/:brushId/thumbnail',
  requireAdmin,
  runSingle('thumbnail'),
  cleanupTempFiles,
  guardDiskBackedUploads,
  replaceAdminBrushThumbnail
)

router.delete(
  '/:appKey/brushes/:brushId/thumbnail',
  requireAdmin,
  removeAdminBrushThumbnail
)

router.delete(
  '/:appKey/brushes/:brushId',
  requireAdmin,
  deleteAdminBrush
)

export default router
