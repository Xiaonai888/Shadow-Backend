import express from 'express'
import multer from 'multer'
import os from 'node:os'
import { unlink } from 'node:fs/promises'
import { requireAdmin } from '../middleware/auth.middleware.js'
import { guardDiskBackedUploads } from '../middleware/globalMediaUploadGuard.middleware.js'
import {
  getAdminGames,
  updateAdminGame,
  uploadAdminGameProfile,
} from '../controllers/gameSettings.controller.js'

const router = express.Router()
const allowedTypes = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/avif',
])

const upload = multer({
  dest: os.tmpdir(),
  limits: {
    fileSize: 20 * 1024 * 1024,
    files: 1,
  },
  fileFilter(req, file, callback) {
    if (allowedTypes.has(file.mimetype)) {
      return callback(null, true)
    }

    const error = new Error(
      'Only JPEG, PNG, WEBP, GIF or AVIF images are allowed'
    )
    error.statusCode = 400
    return callback(error)
  },
})

async function removeTempFile(req) {
  if (req.file?.path) {
    await unlink(req.file.path).catch(() => {})
  }
}

function runUpload(req, res, next) {
  upload.single('profile')(req, res, (error) => {
    if (!error) return next()

    removeTempFile(req).catch(() => {})

    return res.status(error.statusCode || 400).json({
      ok: false,
      message:
        error.code === 'LIMIT_FILE_SIZE'
          ? 'Profile image must be 20 MB or smaller'
          : error.message || 'Invalid image',
    })
  })
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

router.get('/', requireAdmin, getAdminGames)
router.patch('/:gameKey', requireAdmin, updateAdminGame)
router.post(
  '/:gameKey/profile',
  requireAdmin,
  runUpload,
  cleanupTempFile,
  guardDiskBackedUploads,
  uploadAdminGameProfile
)

export default router
