import express from 'express'
import {
  claimMailReward,
  getMyMailUnreadCount,
  getMyMails,
  markMailAsRead,
} from '../controllers/readerMails.controller.js'
import { requireUser } from '../middleware/user.middleware.js'

const router = express.Router()

router.get('/', requireUser, getMyMails)
router.get('/unread-count', requireUser, getMyMailUnreadCount)
router.patch('/:mailId/read', requireUser, markMailAsRead)
router.patch('/:mailId/claim', requireUser, claimMailReward)

export default router
