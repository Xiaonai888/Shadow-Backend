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
  reorderAdminOpeningAdItems,
  updateAdminOpeningAdItem,
  updateAdminOpeningRotationSettings,
  updateLegacyOpeningAdvertisement,
} from '../controllers/openingAdRotation.controller.js'
import {
  archiveAdminRotatingAdvertisementItem,
  createAdminRotatingAdvertisementItem,
  getAdminRotatingAdvertisement,
  getPublicRotatingAdvertisement,
  restoreAdminRotatingAdvertisementItem,
  reorderAdminRotatingAdvertisementItems,
  updateAdminRotatingAdvertisementItem,
  updateAdminRotatingAdvertisementSettings,
  updateLegacyRotatingAdvertisement,
} from '../controllers/adRotation.controller.js'
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
  return cacheAdvertisementResponse(req, res, () => {
    const placement = String(req.query?.placement || '').trim()

    if (placement === 'opening') {
      return getPublicOpeningAdvertisement(req, res)
    }

    if (placement === 'freeUnlock' || placement === 'me') {
      return getPublicRotatingAdvertisement(req, res)
    }

    return getPublicAdvertisement(req, res, next)
  })
}

function updateAdvertisementHandler(req, res, next) {
  const placement = String(req.params?.placement || '').trim()

  if (placement === 'opening') {
    return updateLegacyOpeningAdvertisement(req, res)
  }

  if (placement === 'freeUnlock' || placement === 'me') {
    return updateLegacyRotatingAdvertisement(req, res)
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
router.post('/admin/opening-rotation/reorder', requireAdmin, reorderAdminOpeningAdItems)

router.get('/admin/rotation/:placement', requireAdmin, getAdminRotatingAdvertisement)
router.put('/admin/rotation/:placement/settings', requireAdmin, updateAdminRotatingAdvertisementSettings)
router.post(
  '/admin/rotation/:placement/items',
  requireAdmin,
  uploadAdvertisementImage,
  cleanupTempFile,
  createAdminRotatingAdvertisementItem,
)
router.put(
  '/admin/rotation/:placement/items/:id',
  requireAdmin,
  uploadAdvertisementImage,
  cleanupTempFile,
  updateAdminRotatingAdvertisementItem,
)
router.delete(
  '/admin/rotation/:placement/items/:id',
  requireAdmin,
  archiveAdminRotatingAdvertisementItem,
)
router.post(
  '/admin/rotation/:placement/items/:id/restore',
  requireAdmin,
  restoreAdminRotatingAdvertisementItem,
)
router.post(
  '/admin/rotation/:placement/reorder',
  requireAdmin,
  reorderAdminRotatingAdvertisementItems,
)

router.put(
  '/admin/:placement',
  requireAdmin,
  uploadAdvertisementImage,
  cleanupTempFile,
  updateAdvertisementHandler,
)

export default router
