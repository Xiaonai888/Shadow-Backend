import express from 'express'
import multer from 'multer'
import os from 'node:os'
import { unlink } from 'node:fs/promises'
import { rateLimit } from 'express-rate-limit'
import {
  createAdminAnnouncement,
  deleteAdminAnnouncement,
  getAdminAnnouncementRecords,
  getAdminAnnouncements,
  updateAdminAnnouncement,
  uploadAdminNotificationImage,
} from '../controllers/adminNotifications.controller.js'
import { requireAdmin } from '../middleware/auth.middleware.js'
import path from 'node:path'

const router = express.Router()

const adminNotificationReadLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 600,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {
    ok: false,
    code: 'ADMIN_NOTIFICATION_READ_RATE_LIMIT',
    message: 'Too many admin notification requests. Please retry shortly.',
  },
})

const adminNotificationWriteLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {
    ok: false,
    code: 'ADMIN_NOTIFICATION_WRITE_RATE_LIMIT',
    message: 'Too many admin notification changes. Please retry shortly.',
  },
})

const adminNotificationUploadLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {
    ok: false,
    code: 'ADMIN_NOTIFICATION_UPLOAD_RATE_LIMIT',
    message: 'Too many admin notification uploads. Please retry shortly.',
  },
})

const upload = multer({
  dest: os.tmpdir(),
  limits: {
    fileSize: 5 * 1024 * 1024,
    files: 1,
  },
})

async function removeTempFile(req) {
  const fileName = req.file?.filename
  if (typeof fileName !== 'string' || !/^[a-f0-9]{32}$/i.test(fileName)) return
  const expectedPath = path.join(os.tmpdir(), fileName)
  if (req.file.path !== expectedPath) return
  await unlink(expectedPath).catch(() => {})
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
  adminNotificationReadLimit,
  requireAdmin,
  getAdminAnnouncements
)

router.post(
  '/announcements',
  adminNotificationWriteLimit,
  requireAdmin,
  createAdminAnnouncement
)

router.patch(
  '/announcements/:referenceId',
  adminNotificationWriteLimit,
  requireAdmin,
  updateAdminAnnouncement
)

router.delete(
  '/announcements/:referenceId',
  adminNotificationWriteLimit,
  requireAdmin,
  deleteAdminAnnouncement
)

router.post(
  '/upload-image',
  adminNotificationUploadLimit,
  requireAdmin,
  uploadNotificationImage,
  cleanupTempFile,
  uploadAdminNotificationImage
)

router.get(
  '/records',
  adminNotificationReadLimit,
  requireAdmin,
  getAdminAnnouncementRecords
)

export default router
