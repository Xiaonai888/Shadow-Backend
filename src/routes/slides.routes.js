import express from 'express'
import multer from 'multer'
import os from 'node:os'
import { unlink } from 'node:fs/promises'
import { requireAdmin } from '../middleware/auth.middleware.js'
import { createSpamGuard } from '../middleware/spamGuard.middleware.js'
import { createRateLimit } from '../middleware/rateLimit.middleware.js'
import {
  createSlide,
  deleteSlide,
  getSlideActivityLogs,
  getSlides,
  updateSlide,
} from '../controllers/slides.controller.js'
import { getHomeSlidesBatch } from '../controllers/homeSlides.controller.js'
import {
  cacheSlidesResponse,
  invalidateSlidesResponseCache,
} from '../services/slidesResponseCache.service.js'

const router = express.Router()

const upload = multer({
  dest: os.tmpdir(),
  limits: {
    fileSize: 5 * 1024 * 1024,
    files: 1,
  },
})

const publicSlidesCacheHitLimit = createRateLimit({
  key: 'public-slides-cache-hit',
  windowMs: 60 * 1000,
  max: 1500,
  message: 'Too many requests. Please wait before trying again.',
})

const publicSlidesReadSpamGuard = createSpamGuard({
  scope: 'reader_read',
  threshold: 300,
  windowSeconds: 60,
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

function uploadSlideImage(req, res, next) {
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
        'SLIDE_IMAGE_UPLOAD_INVALID',
      message:
        error.code === 'LIMIT_FILE_SIZE'
          ? 'Image must be 5 MB or smaller'
          : error.message ||
            'Invalid slide image',
    })
  })
}

function invalidateSlidesAfterMutation(req, res, next) {
  res.once('finish', () => {
    if (
      res.statusCode >= 200 &&
      res.statusCode < 300
    ) {
      invalidateSlidesResponseCache()
    }
  })

  next()
}

router.get(
  '/',
  publicSlidesCacheHitLimit,
  cacheSlidesResponse,
  publicSlidesReadSpamGuard,
  getSlides
)
router.get(
  '/home-batch',
  publicSlidesCacheHitLimit,
  cacheSlidesResponse,
  publicSlidesReadSpamGuard,
  getHomeSlidesBatch
)

router.get(
  '/records',
  requireAdmin,
  getSlideActivityLogs
)

router.post(
  '/',
  requireAdmin,
  uploadSlideImage,
  cleanupTempFile,
  invalidateSlidesAfterMutation,
  createSlide
)

router.put(
  '/:id',
  requireAdmin,
  uploadSlideImage,
  cleanupTempFile,
  invalidateSlidesAfterMutation,
  updateSlide
)

router.delete(
  '/:id',
  requireAdmin,
  invalidateSlidesAfterMutation,
  deleteSlide
)

export default router
