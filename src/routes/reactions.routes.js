import express from 'express'
import jwt from 'jsonwebtoken'

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

const router = express.Router()

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

router.get('/episode/:episodeId/status', optionalUser, getEpisodeReactionStatus)
router.post('/episode/:episodeId/toggle', requireUser, toggleEpisodeReaction)
router.get('/episode/:episodeId', getEpisodeReactions)
router.get('/story/:storyId', optionalUser, getStoryReactionStatus)
router.get('/story/:storyId/users', getStoryReactions)
router.post('/story/:storyId/toggle', requireUser, toggleStoryReaction)

export default router
