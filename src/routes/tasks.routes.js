import express from 'express'
import { requireUser } from '../middleware/user.middleware.js'
import {
  claimTaskCheckIn,
  getTaskCheckIn,
  getTaskHistory,
} from '../controllers/tasks.controller.js'

const router = express.Router()

router.get('/check-in', requireUser, getTaskCheckIn)
router.post('/check-in/claim', requireUser, claimTaskCheckIn)
router.get('/history', requireUser, getTaskHistory)

export default router
