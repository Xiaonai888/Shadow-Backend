import express from 'express'
import {
  createStory,
  getMyStories,
  getStoryById,
} from '../controllers/stories.controller.js'
import { requireUser } from '../middleware/user.middleware.js'

const router = express.Router()

router.post('/create', requireUser, createStory)
router.get('/my', requireUser, getMyStories)
router.get('/:storyId', requireUser, getStoryById)

export default router
