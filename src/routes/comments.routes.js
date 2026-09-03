import express from 'express'
import {
  getLatestStoryComment,
  getEpisodeCommentTotals,
  createEpisodeComment,
  getEpisodeComments,
  getCommentReplies,
  createStoryComment,
  getMyCommentActivities,
  getStoryComments,
  moderateComment,
  toggleCommentLike,
  updateOwnComment,
} from '../controllers/comments.controller.js'
import { requireUser } from '../middleware/user.middleware.js'

const router = express.Router()

router.get('/episode-totals', getEpisodeCommentTotals)
router.get('/episode/:episodeId', getEpisodeComments)
router.post('/episode/:episodeId', requireUser, createEpisodeComment)
router.get('/me/activities', requireUser, getMyCommentActivities)
router.get(
  '/story/:storyId/latest',
  getLatestStoryComment
)
router.get('/story/:storyId', getStoryComments)
router.post('/story/:storyId', requireUser, createStoryComment)
router.get('/:commentId/replies', getCommentReplies)
router.post('/:commentId/like', requireUser, toggleCommentLike)
router.patch('/:commentId', requireUser, updateOwnComment)
router.patch('/:commentId/moderate', requireUser, moderateComment)

export default router
