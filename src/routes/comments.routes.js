import express from 'express'
import {
  getLatestStoryComment,
  getEpisodeCommentTotals,
  createEpisodeComment,
  getEpisodeComments,
  getCommentReplies,
  getCommentThread,
  createStoryComment,
  getMyCommentActivities,
  getStoryComments,
  markMyAuthorCommentRead,
  moderateComment,
  toggleCommentLike,
  updateOwnComment,
} from '../controllers/comments.controller.js'
import { getMyAuthorUnreadCommentCount } from '../controllers/authorCommentUnread.controller.js'
import { requireUser } from '../middleware/user.middleware.js'
import { invalidatePublicStoriesCache } from '../services/publicStoriesResponseCache.service.js'

const router = express.Router()

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

router.get('/episode-totals', getEpisodeCommentTotals)
router.get('/episode/:episodeId', getEpisodeComments)
router.post(
  '/episode/:episodeId',
  requireUser,
  invalidatePublicStoriesAfterMutation,
  createEpisodeComment
)
router.get('/me/activities', requireUser, getMyCommentActivities)
router.get(
  '/me/author-unread-count',
  requireUser,
  getMyAuthorUnreadCommentCount
)
router.get(
  '/story/:storyId/latest',
  getLatestStoryComment
)
router.get('/story/:storyId', getStoryComments)
router.post(
  '/story/:storyId',
  requireUser,
  invalidatePublicStoriesAfterMutation,
  createStoryComment
)
router.get('/:commentId/replies', getCommentReplies)
router.get('/:commentId/thread', requireUser, getCommentThread)
router.patch(
  '/:commentId/author-read',
  requireUser,
  markMyAuthorCommentRead
)
router.post('/:commentId/like', requireUser, toggleCommentLike)
router.patch(
  '/:commentId',
  requireUser,
  invalidatePublicStoriesAfterMutation,
  updateOwnComment
)
router.patch(
  '/:commentId/moderate',
  requireUser,
  invalidatePublicStoriesAfterMutation,
  moderateComment
)

export default router
