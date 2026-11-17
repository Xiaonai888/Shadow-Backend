import express from 'express'
import { createHash } from 'node:crypto'
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
const OVERVIEW_CACHE_TTL_MS = 2000
const OVERVIEW_CACHE_LIMIT = 200
const OVERVIEW_INFLIGHT_LIMIT = 128
const OVERVIEW_VERSION_LIMIT = 2000
const overviewCache = new Map()
const overviewPending = new Map()
const overviewVersions = new Map()

router.use(rateLimit({
  windowMs: 60 * 1000,
  limit: 3000,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
}))

const overviewIpRateLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 1200,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {
    ok: false,
    code: 'TASK_OVERVIEW_IP_RATE_LIMIT',
    message: 'Too many overview requests. Please try again shortly.',
  },
})

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

function taskUserId(req) {
  return String(req.user?.user_id || req.user?.id || '').trim()
}

function invalidateOverviewOnMutation(req, res, next) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next()

  res.once('finish', () => {
    if (res.statusCode < 200 || res.statusCode >= 300) return

    const userId = taskUserId(req)
    if (!userId) return

    const version = (overviewVersions.get(userId) || 0) + 1
    overviewVersions.delete(userId)
    overviewVersions.set(userId, version)

    while (overviewVersions.size > OVERVIEW_VERSION_LIMIT) {
      overviewVersions.delete(overviewVersions.keys().next().value)
    }

    for (const [key, cached] of overviewCache) {
      if (cached.userId === userId) overviewCache.delete(key)
    }
  })

  return next()
}

function cacheTaskOverview(req, res, next) {
  const userId = taskUserId(req)
  const authorization = String(req.headers.authorization || '').trim()

  if (!userId || !authorization) return next()

  const version = overviewVersions.get(userId) || 0
  const tokenHash = createHash('sha256').update(authorization).digest('hex')
  const key = `${userId}:${tokenHash}:${version}`
  const now = Date.now()
  const cached = overviewCache.get(key)

  if (cached && cached.expiresAt > now) {
    overviewCache.delete(key)
    overviewCache.set(key, cached)
    res.set('Cache-Control', 'private, no-store')
    return res.status(200).json(cached.body)
  }
  if (cached) overviewCache.delete(key)

  const active = overviewPending.get(key)

  if (active) {
    active.then((result) => {
      if (res.headersSent || res.writableEnded || res.destroyed) return
      if (!result) return next()
      res.set('Cache-Control', 'private, no-store')
      return res.status(result.status).json(result.body)
    }).catch(next)
    return
  }

  if (overviewPending.size >= OVERVIEW_INFLIGHT_LIMIT) return next()

  let resolvePending
  const promise = new Promise((resolve) => {
    resolvePending = resolve
  })
  overviewPending.set(key, promise)

  let settled = false
  const finish = (result) => {
    if (settled) return
    settled = true
    if (overviewPending.get(key) === promise) overviewPending.delete(key)
    resolvePending(result)
  }

  const originalJson = res.json.bind(res)
  res.set('Cache-Control', 'private, no-store')

  res.json = (body) => {
    const status = res.statusCode || 200

    if (
      status === 200 &&
      body?.ok === true &&
      (overviewVersions.get(userId) || 0) === version
    ) {
      overviewCache.delete(key)
      overviewCache.set(key, {
        userId,
        body,
        expiresAt: Date.now() + OVERVIEW_CACHE_TTL_MS,
      })

      while (overviewCache.size > OVERVIEW_CACHE_LIMIT) {
        overviewCache.delete(overviewCache.keys().next().value)
      }
    }

    finish({ status, body })
    return originalJson(body)
  }

  res.once('close', () => finish(null))
  return next()
}

router.use(invalidateOverviewOnMutation)

router.get('/overview', overviewIpRateLimit, requireUser, taskRateLimit, cacheTaskOverview, getTaskOverview)

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
