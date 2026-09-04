import express from 'express'
import multer from 'multer'
import os from 'node:os'
import { unlink } from 'node:fs/promises'
import { requireUser } from '../middleware/user.middleware.js'
import { uploadImageToR2AsWebP } from '../services/r2Storage.service.js'
import { createFastVideo } from '../controllers/fastVideos.controller.js'

const router = express.Router()

const upload = multer({
  dest: os.tmpdir(),
  limits: {
    fileSize: 5 * 1024 * 1024,
    files: 1,
  },
  fileFilter(req, file, callback) {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp']

    if (!allowedTypes.includes(file.mimetype)) {
      const error = new Error('Thumbnail must be JPG, JPEG, PNG, or WEBP')
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

function uploadThumbnail(req, res, next) {
  upload.single('thumbnail')(req, res, (error) => {
    if (!error) return next()

    removeTempFile(req).catch(() => {})
    return next(error)
  })
}

router.post(
  '/upload-thumbnail',
  requireUser,
  uploadThumbnail,
  cleanupTempFile,
  async (req, res) => {
    try {
      const userId = req.user?.user_id

      if (!userId) {
        return res.status(401).json({
          ok: false,
          message: 'Unauthorized',
        })
      }

      if (!req.file) {
        return res.status(400).json({
          ok: false,
          message: 'Thumbnail file is required. Use form field name: thumbnail',
        })
      }

      const thumbnailUrl = await uploadImageToR2AsWebP(
        req.file,
        `fast/thumbnails/${userId}`,
        {
          width: 1280,
          height: 720,
          fit: 'cover',
          quality: 82,
          minQuality: 58,
          qualityStep: 6,
          maxBytes: 300 * 1024,
          fallbackWidth: 960,
          fallbackHeight: 540,
        }
      )

      return res.status(201).json({
        ok: true,
        message: 'Thumbnail uploaded and compressed successfully',
        thumbnail_url: thumbnailUrl,
        thumbnailUrl,
      })
    } catch (error) {
      console.error('FAST THUMBNAIL UPLOAD ERROR:', error)

      return res.status(error.statusCode || 500).json({
        ok: false,
        message: error.message || 'Failed to upload thumbnail',
      })
    }
  }
)

router.post('/videos', requireUser, createFastVideo)

router.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    return res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({
      ok: false,
      message:
        error.code === 'LIMIT_FILE_SIZE'
          ? 'Thumbnail must be 5 MB or smaller'
          : error.message,
    })
  }

  if (error) {
    return res.status(error.statusCode || 400).json({
      ok: false,
      message: error.message || 'Thumbnail upload failed',
    })
  }

  return next()
})

export default router
