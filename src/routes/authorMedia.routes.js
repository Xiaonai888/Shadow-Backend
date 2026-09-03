import express from 'express'
import multer from 'multer'
import os from 'node:os'
import { unlink } from 'node:fs/promises'
import { requireUser } from '../middleware/user.middleware.js'
import {
  getMyAuthorStorageQuota,
  uploadMyAuthorProfileImage,
} from '../controllers/authorMedia.controller.js'

const router = express.Router()

const upload = multer({
  dest: os.tmpdir(),
  limits: {
    fileSize: 2 * 1024 * 1024,
    files: 1,
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

function uploadProfileImage(req, res, next) {
  upload.single('image')(req, res, (error) => {
    if (!error) return next()

    removeTempFile(req).catch(() => {})

    const status =
      error.code === 'LIMIT_FILE_SIZE'
        ? 413
        : 400

    return res.status(status).json({
      ok: false,
      code:
        error.code ||
        'AUTHOR_PROFILE_IMAGE_UPLOAD_INVALID',
      message:
        error.code === 'LIMIT_FILE_SIZE'
          ? 'Image must be 2 MB or smaller'
          : error.message ||
            'Invalid image upload',
    })
  })
}

router.get(
  '/storage',
  requireUser,
  getMyAuthorStorageQuota
)

router.post(
  '/profile-image',
  requireUser,
  uploadProfileImage,
  cleanupTempFile,
  uploadMyAuthorProfileImage
)

export default router
