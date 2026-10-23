import express from 'express'
import jwt from 'jsonwebtoken'
import { rateLimit } from 'express-rate-limit'

import {
  getStoryReactions,
  getStoryReactionStatus,
  toggleStoryReaction,
} from '../controllers/reactions.controller.js'
import {
  getEpisodeReactions,
  getEpisodeReactionStatus,
  toggleEpisodeReaction,
} from '../controllers/episodeReactions.controller.js'
import { requireUser } from '../middleware/user.middleware.js'
import { invalidatePublicStoriesCache } from '../services/publicStoriesResponseCache.service.js'

const router = express.Router()
const reactionPreAuthLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 1200,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
})
const reactionToggleLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req) => String(req.user?.user_id || req.user?.id || req.user?.session_id || 'unauthenticated'),
})

router.use(reactionPreAuthLimit)

function optionalUser(req, res, next) {
  try {
    const authHeader = req.headers.authorization || ''
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''

    if (!token || !process.env.JWT_SECRET) return next()

    const decoded = jwt.verify(token, process.env.JWT_SECRET)

    if (decoded.type === 'reader') {
      req.user = decoded
    }

    return next()
  } catch {
    return next()
  }
}

function invalidatePublicStoriesAfterMutation(req, res, next) {
  res.once('finish', () => {
    if (
      res.statusCode >= 200 &&
      res.statusCode < 300
    ) {
      invalidatePublicStoriesCache()
    }
  })

  next()
}

router.get('/episode/:episodeId/status', optionalUser, getEpisodeReactionStatus)
router.post('/episode/:episodeId/toggle', requireUser, reactionToggleLimit, toggleEpisodeReaction)
router.get('/episode/:episodeId', getEpisodeReactions)
router.get('/story/:storyId', optionalUser, getStoryReactionStatus)
router.get('/story/:storyId/users', getStoryReactions)
router.post(
  '/story/:storyId/toggle',
  requireUser,
  reactionToggleLimit,
  invalidatePublicStoriesAfterMutation,
  toggleStoryReaction
)

export default router
