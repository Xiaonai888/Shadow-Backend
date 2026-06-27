import express from 'express'
import {
  claimMailReward,
  getDailyCheckInReminder,
  getMyMailUnreadCount,
  getMyMails,
  markMailAsRead,
  runDailyCheckInReminderMails,
  updateDailyCheckInReminder,
} from '../controllers/readerMails.controller.js'
import { requireUser } from '../middleware/user.middleware.js'

const router = express.Router()

router.get('/', requireUser, getMyMails)
router.get('/unread-count', requireUser, getMyMailUnreadCount)
router.get('/daily-checkin-reminder', requireUser, getDailyCheckInReminder)
router.patch('/daily-checkin-reminder', requireUser, updateDailyCheckInReminder)
router.post('/daily-checkin-reminder/run', runDailyCheckInReminderMails)
router.patch('/:mailId/read', requireUser, markMailAsRead)
router.patch('/:mailId/claim', requireUser, claimMailReward)

export default router
