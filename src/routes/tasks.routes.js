import express from 'express'
import { rateLimit } from 'express-rate-limit'
import { requireUser } from '../middleware/user.middleware.js'
import {
  claimReadingMissionReward,
  claimReadingReward,
  claimRewardChest,
  claimTaskCheckIn,
  getReadingMission,
  getReadingMissions,
  getReadingReward,
  getRewardChest,
  getTaskCheckIn,
  getTaskHistory,
  trackReadingMissionProgress,
  trackReadingRewardProgress,
  trackReadingSessionProgress,
  claimDailyVoteReward,
  getDailyVoteReward,
  getTaskOverview,
} from '../controllers/tasks.controller.js'
import { getWeeklyReading, claimWeeklyReadingReward } from '../controllers/weeklyReading.controller.js'

const router = express.Router()
router.use(rateLimit({
  windowMs: 60 * 1000,
  limit: 3000,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
}))
const taskRateLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 300,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req) => String(req.user?.user_id || req.user?.id || req.user?.session_id || 'unauthenticated'),
  message: {
    ok: false,
    code: 'TASK_RATE_LIMIT',
    message: 'Too many task requests. Please try again shortly.',
  },
})

router.get('/overview', requireUser, taskRateLimit, getTaskOverview)

router.get('/check-in', requireUser, taskRateLimit, getTaskCheckIn)
router.post('/check-in/claim', requireUser, taskRateLimit, claimTaskCheckIn)

router.get('/reward-chest', requireUser, taskRateLimit, getRewardChest)
router.post('/reward-chest/claim', requireUser, taskRateLimit, claimRewardChest)

router.get('/reading-reward', requireUser, taskRateLimit, getReadingReward)
router.post('/reading-reward/progress', requireUser, taskRateLimit, trackReadingRewardProgress)
router.post('/reading-reward/claim', requireUser, taskRateLimit, claimReadingReward)
router.get('/weekly-reading', requireUser, taskRateLimit, getWeeklyReading)
router.post('/weekly-reading/claim', requireUser, taskRateLimit, claimWeeklyReadingReward)

router.post('/reading-session/progress', requireUser, taskRateLimit, trackReadingSessionProgress)

router.get('/reading-missions', requireUser, taskRateLimit, getReadingMissions)
router.get('/reading-missions/:missionId', requireUser, taskRateLimit, getReadingMission)
router.post('/reading-missions/:missionId/progress', requireUser, taskRateLimit, trackReadingMissionProgress)
router.post('/reading-missions/:missionId/claim', requireUser, taskRateLimit, claimReadingMissionReward)

router.get('/daily-vote-reward', requireUser, taskRateLimit, getDailyVoteReward)
router.post('/daily-vote-reward/claim', requireUser, taskRateLimit, claimDailyVoteReward)
router.get('/history', requireUser, taskRateLimit, getTaskHistory)

export default router
