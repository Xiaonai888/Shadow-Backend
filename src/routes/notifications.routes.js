import express from 'express'
import {
  getMyNotificationUnreadCount,
  getMyNotifications,
  markAllNotificationsAsRead,
  markNotificationAsRead,
} from '../controllers/notifications.controller.js'
import { requireUser } from '../middleware/user.middleware.js'

const router = express.Router()

router.get('/', requireUser, getMyNotifications)
router.get('/unread-count', requireUser, getMyNotificationUnreadCount)
router.patch('/read-all', requireUser, markAllNotificationsAsRead)
router.patch('/:notificationId/read', requireUser, markNotificationAsRead)

export default router
