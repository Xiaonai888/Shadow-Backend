import express from 'express'
import multer from 'multer'
import os from 'node:os'
import { unlink } from 'node:fs/promises'
import {
  createAdminAnnouncement,
  deleteAdminAnnouncement,
  getAdminAnnouncementRecords,
  getAdminAnnouncements,
  updateAdminAnnouncement,
  uploadAdminNotificationImage,
} from '../controllers/adminNotifications.controller.js'
import { requireAdmin } from '../middleware/auth.middleware.js'

const router = express.Router()

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

function uploadNotificationImage(req, res, next) {
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
        'NOTIFICATION_IMAGE_UPLOAD_INVALID',
      message:
        error.code === 'LIMIT_FILE_SIZE'
          ? 'Image must be 5 MB or smaller'
          : error.message ||
            'Invalid notification image',
    })
  })
}

router.get(
  '/announcements',
  requireAdmin,
  getAdminAnnouncements
)

router.post(
  '/announcements',
  requireAdmin,
  createAdminAnnouncement
)

router.patch(
  '/announcements/:referenceId',
  requireAdmin,
  updateAdminAnnouncement
)

router.delete(
  '/announcements/:referenceId',
  requireAdmin,
  deleteAdminAnnouncement
)

router.post(
  '/upload-image',
  requireAdmin,
  uploadNotificationImage,
  cleanupTempFile,
  uploadAdminNotificationImage
)

router.get(
  '/records',
  requireAdmin,
  getAdminAnnouncementRecords
)

export default router
