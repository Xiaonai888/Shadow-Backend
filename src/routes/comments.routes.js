import express from 'express'
import {
  createStoryComment,
  getStoryComments,
  moderateComment,
  updateOwnComment,
} from '../controllers/comments.controller.js'
import { requireUser } from '../middleware/user.middleware.js'

const router = express.Router()

router.get('/story/:storyId', getStoryComments)
router.post('/story/:storyId', requireUser, createStoryComment)
router.patch('/:commentId', requireUser, updateOwnComment)
router.patch('/:commentId/moderate', requireUser, moderateComment)

export default router
