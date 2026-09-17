import express from 'express'
import {
  getDiscoverStoriesFeed,
} from '../controllers/discoverStories.controller.js'
import {
  getDiscoverStoryReactionStatus,
  toggleDiscoverStoryReaction,
} from '../controllers/discoverStoryReactions.controller.js'
import {
  requireUser,
} from '../middleware/user.middleware.js'

const router = express.Router()

router.get(
  '/feed',
  requireUser,
  getDiscoverStoriesFeed
)

router.get(
  '/:sourceType/:storyId/reaction',
  requireUser,
  getDiscoverStoryReactionStatus
)

router.post(
  '/:sourceType/:storyId/reaction',
  requireUser,
  toggleDiscoverStoryReaction
)

export default router
