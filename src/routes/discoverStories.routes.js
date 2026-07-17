import express from 'express'
import {
  getDiscoverStoriesFeed,
} from '../controllers/discoverStories.controller.js'
import {
  requireUser,
} from '../middleware/user.middleware.js'

const router = express.Router()

router.get(
  '/feed',
  requireUser,
  getDiscoverStoriesFeed
)

export default router
