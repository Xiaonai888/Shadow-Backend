import express from 'express'
import {
  createMyReaderPost,
  deleteMyReaderPost,
  getMyReaderPosts,
  getReaderPostsByUsername,
  getReaderPostsFeed,
  updateMyReaderPost,
} from '../controllers/readerPosts.controller.js'
import {
  getReaderPostReactionStatus,
  setReaderPostReaction,
} from '../controllers/readerPostReactions.controller.js'
import {
  createReaderPostComment,
  deleteOwnReaderPostComment,
  getReaderPostComments,
  toggleReaderPostCommentLike,
  updateOwnReaderPostComment,
} from '../controllers/readerPostComments.controller.js'
import { requireUser } from '../middleware/user.middleware.js'

const router = express.Router()

router.get('/feed', requireUser, getReaderPostsFeed)
router.get('/me', requireUser, getMyReaderPosts)
router.post('/me', requireUser, createMyReaderPost)
router.patch('/me/:postId', requireUser, updateMyReaderPost)
router.delete('/me/:postId', requireUser, deleteMyReaderPost)

router.get(
  '/:postId/reaction',
  requireUser,
  getReaderPostReactionStatus
)
router.post(
  '/:postId/reaction',
  requireUser,
  setReaderPostReaction
)

router.get(
  '/:postId/comments',
  requireUser,
  getReaderPostComments
)
router.post(
  '/:postId/comments',
  requireUser,
  createReaderPostComment
)
router.patch(
  '/comments/:commentId',
  requireUser,
  updateOwnReaderPostComment
)
router.delete(
  '/comments/:commentId',
  requireUser,
  deleteOwnReaderPostComment
)
router.post(
  '/comments/:commentId/like',
  requireUser,
  toggleReaderPostCommentLike
)

router.get(
  '/user/:username',
  requireUser,
  getReaderPostsByUsername
)

export default router
