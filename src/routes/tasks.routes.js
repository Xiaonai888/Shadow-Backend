import express from 'express'
import { requireUser } from '../middleware/user.middleware.js'
import {
  claimRewardChest,
  claimTaskCheckIn,
  getRewardChest,
  getTaskCheckIn,
  getTaskHistory,
} from '../controllers/tasks.controller.js'
const router = express.Router()

router.get('/check-in', requireUser, getTaskCheckIn)
router.post('/check-in/claim', requireUser, claimTaskCheckIn)
router.get('/reward-chest', requireUser, getRewardChest)
router.post('/reward-chest/claim', requireUser, claimRewardChest)
router.get('/history', requireUser, getTaskHistory)

export default router
