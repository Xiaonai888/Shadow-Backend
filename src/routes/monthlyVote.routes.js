import express from 'express'
import { requireUser } from '../middleware/user.middleware.js'
import {
  castMonthlyVote,
  getActiveMonthlyVote,
  getMonthlyVoteBalance,
  getPreviousMonthlyVoteWinners,
} from '../controllers/monthlyVote.controller.js'

const router = express.Router()

router.get('/active', getActiveMonthlyVote)
router.get('/previous-winners', getPreviousMonthlyVoteWinners)
router.get('/balance', requireUser, getMonthlyVoteBalance)
router.post('/cast', requireUser, castMonthlyVote)

export default router
