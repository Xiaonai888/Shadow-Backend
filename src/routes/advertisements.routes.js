import { cacheAdvertisementResponse } from '../services/advertisementsResponseCache.service.js'
import { createRateLimit } from '../middleware/rateLimit.middleware.js'
import express from 'express'
import multer from 'multer'
import os from 'node:os'
import { unlink } from 'node:fs/promises'
import {
  getAdminAdvertisementLogs,
  getAdminAdvertisements,
  getPublicAdvertisement,
  updateAdminAdvertisement,
} from '../controllers/advertisements.controller.js'
import {
  archiveAdminOpeningAdItem,
  createAdminOpeningAdItem,
  getAdminOpeningRotation,
  getPublicOpeningAdvertisement,
  restoreAdminOpeningAdItem,
  updateAdminOpeningAdItem,
  updateAdminOpeningRotationSettings,
  updateLegacyOpeningAdvertisement,
} from '../controllers/openingAdRotation.controller.js'
import { requireAdmin } from '../middleware/auth.middleware.js'

const router = express.Router()
const publicAdvertisementRateLimit = createRateLimit({
  key: 'public_advertisements',
  windowMs: 60000,
  max: 120,
})

const upload = multer({
  dest: os.tmpdir(),
  limits: {
    fileSize: 5 * 1024 * 1024,
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

function uploadAdvertisementImage(req, res, next) {
  upload.single('image')(req, res, (error) => {
    if (!error) return next()

    removeTempFile(req).catch(() => {})

    const status = error.code === 'LIMIT_FILE_SIZE' ? 413 : 400

    return res.status(status).json({
      ok: false,
      code: error.code || 'ADVERTISEMENT_IMAGE_UPLOAD_INVALID',
      message:
        error.code === 'LIMIT_FILE_SIZE'
          ? 'Image must be 5 MB or smaller'
          : error.message || 'Invalid advertisement image',
    })
  })
}

function getPublicAdvertisementHandler(req, res, next) {
  if (String(req.query?.placement || '').trim() === 'opening') {
    return getPublicOpeningAdvertisement(req, res)
  }

  return cacheAdvertisementResponse(req, res, () => getPublicAdvertisement(req, res, next))
}

function updateAdvertisementHandler(req, res, next) {
  if (String(req.params?.placement || '').trim() === 'opening') {
    return updateLegacyOpeningAdvertisement(req, res)
  }

  return updateAdminAdvertisement(req, res, next)
}

router.get('/public', publicAdvertisementRateLimit, getPublicAdvertisementHandler)
router.get('/admin', requireAdmin, getAdminAdvertisements)
router.get('/admin/logs', requireAdmin, getAdminAdvertisementLogs)
router.get('/admin/opening-rotation', requireAdmin, getAdminOpeningRotation)
router.put('/admin/opening-rotation/settings', requireAdmin, updateAdminOpeningRotationSettings)
router.post(
  '/admin/opening-rotation/items',
  requireAdmin,
  uploadAdvertisementImage,
  cleanupTempFile,
  createAdminOpeningAdItem,
)
router.put(
  '/admin/opening-rotation/items/:id',
  requireAdmin,
  uploadAdvertisementImage,
  cleanupTempFile,
  updateAdminOpeningAdItem,
)
router.delete('/admin/opening-rotation/items/:id', requireAdmin, archiveAdminOpeningAdItem)
router.post('/admin/opening-rotation/items/:id/restore', requireAdmin, restoreAdminOpeningAdItem)

router.put(
  '/admin/:placement',
  requireAdmin,
  uploadAdvertisementImage,
  cleanupTempFile,
  updateAdvertisementHandler,
)

export default router
