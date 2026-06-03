import express from 'express'
import multer from 'multer'
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
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024,
    files: 1,
  },
})

router.get('/announcements', requireAdmin, getAdminAnnouncements)
router.post('/announcements', requireAdmin, createAdminAnnouncement)
router.patch('/announcements/:referenceId', requireAdmin, updateAdminAnnouncement)
router.delete('/announcements/:referenceId', requireAdmin, deleteAdminAnnouncement)
router.post('/upload-image', requireAdmin, upload.single('image'), uploadAdminNotificationImage)
router.get('/records', requireAdmin, getAdminAnnouncementRecords)


export default router
