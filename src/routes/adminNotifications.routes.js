import express from 'express'
import {
  createAdminAnnouncement,
  deleteAdminAnnouncement,
  getAdminAnnouncementRecords,
  getAdminAnnouncements,
  updateAdminAnnouncement,
} from '../controllers/adminNotifications.controller.js'
import { requireAdmin } from '../middleware/auth.middleware.js'

const router = express.Router()

router.get('/announcements', requireAdmin, getAdminAnnouncements)
router.post('/announcements', requireAdmin, createAdminAnnouncement)
router.patch('/announcements/:referenceId', requireAdmin, updateAdminAnnouncement)
router.delete('/announcements/:referenceId', requireAdmin, deleteAdminAnnouncement)
router.get('/records', requireAdmin, getAdminAnnouncementRecords)

export default router
