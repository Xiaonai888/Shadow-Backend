import express from 'express'
import multer from 'multer'
import os from 'node:os'
import { unlink } from 'node:fs/promises'
import {
  deleteShareProfileCustomImage,
  uploadShareProfileCustomImage,
} from '../controllers/shareProfile.controller.js'
import { requireUser } from '../middleware/user.middleware.js'

const router = express.Router()

const upload = multer({
  dest: os.tmpdir(),
  limits: {
    fileSize: 8 * 1024 * 1024,
    files: 1,
  },
  fileFilter(req, file, callback) {
    if (!file.mimetype?.startsWith('image/')) {
      const error = new Error('Only image files are allowed')
      error.statusCode = 400
      return callback(error)
    }

    return callback(null, true)
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

function uploadCustomImage(req, res, next) {
  upload.single('image')(req, res, (error) => {
    if (!error) return next()

    removeTempFile(req).catch(() => {})
    return next(error)
  })
}

router.post(
  '/custom-image',
  requireUser,
  uploadCustomImage,
  cleanupTempFile,
  uploadShareProfileCustomImage
)
router.delete('/custom-image', requireUser, deleteShareProfileCustomImage)

router.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    return res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({
      ok: false,
      message:
        error.code === 'LIMIT_FILE_SIZE'
          ? 'Image must be 8 MB or smaller'
          : error.message,
    })
  }

  if (error) {
    return res.status(error.statusCode || 400).json({
      ok: false,
      message: error.message || 'Invalid image upload',
    })
  }

  return next()
})

export default router
