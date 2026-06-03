import express from 'express'
import {
  createAdminAnnouncement,
  getAdminAnnouncements,
} from '../controllers/adminNotifications.controller.js'
import { requireAdmin } from '../middleware/auth.middleware.js'

const router = express.Router()

router.get('/announcements', requireAdmin, getAdminAnnouncements)
router.post('/announcements', requireAdmin, createAdminAnnouncement)

export default router
