import express from 'express'
import {
  createStoryComment,
  getMyCommentActivities,
  getStoryComments,
  moderateComment,
  toggleCommentLike,
  updateOwnComment,
} from '../controllers/comments.controller.js'
import { requireUser } from '../middleware/user.middleware.js'

const router = express.Router()

router.get('/me/activities', requireUser, getMyCommentActivities)
router.get('/story/:storyId', getStoryComments)
router.post('/story/:storyId', requireUser, createStoryComment)
router.post('/:commentId/like', requireUser, toggleCommentLike)
router.patch('/:commentId', requireUser, updateOwnComment)
router.patch('/:commentId/moderate', requireUser, moderateComment)

export default router
