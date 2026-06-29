import express from 'express'
import { requireUser } from '../middleware/user.middleware.js'
import {
  claimReadingReward,
  claimRewardChest,
  claimTaskCheckIn,
  getReadingReward,
  getRewardChest,
  getTaskCheckIn,
  getTaskHistory,
  trackReadingRewardProgress,
} from '../controllers/tasks.controller.js'
const router = express.Router()

router.get('/check-in', requireUser, getTaskCheckIn)
router.post('/check-in/claim', requireUser, claimTaskCheckIn)
router.get('/reward-chest', requireUser, getRewardChest)
router.post('/reward-chest/claim', requireUser, claimRewardChest)
router.get('/reading-reward', requireUser, getReadingReward)
router.post('/reading-reward/progress', requireUser, trackReadingRewardProgress)
router.post('/reading-reward/claim', requireUser, claimReadingReward)
router.get('/history', requireUser, getTaskHistory)

export default router
