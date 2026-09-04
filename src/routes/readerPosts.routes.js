import express from 'express'
import {
  createMyReaderPost,
  deleteMyReaderPost,
  getMyReaderPosts,
  getReaderPostById,
  getReaderPostsByUsername,
  getReaderPostsFeed,
  updateMyReaderPost,
} from '../controllers/readerPosts.controller.js'

import {
  getReaderPostReactionStatus,
  getReaderPostReactions,
  setReaderPostReaction,
} from '../controllers/readerPostReactions.controller.js'
import {
  createReaderPostComment,
  deleteOwnReaderPostComment,
  getReaderPostComments,
  getReaderPostCommentReplies,
  toggleReaderPostCommentLike,
  updateOwnReaderPostComment,
} from '../controllers/readerPostComments.controller.js'
import {
  createReaderPostEcho,
  getReaderPostEchoes,
} from '../controllers/readerPostEchoes.controller.js'
import { requireUser } from '../middleware/user.middleware.js'

const router = express.Router()

router.get('/feed', requireUser, getReaderPostsFeed)
router.get('/me', requireUser, getMyReaderPosts)
router.get('/:postId', requireUser, getReaderPostById)
router.post('/me', requireUser, createMyReaderPost)
router.patch('/me/:postId', requireUser, updateMyReaderPost)
router.delete('/me/:postId', requireUser, deleteMyReaderPost)

router.get(
  '/:postId/reactions',
  requireUser,
  getReaderPostReactions
)

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
  '/comments/:commentId/replies',
  requireUser,
  getReaderPostCommentReplies
)

router.get(
  '/:postId/echoes',
  requireUser,
  getReaderPostEchoes
)
router.post(
  '/:postId/echoes',
  requireUser,
  createReaderPostEcho
)

router.get(
  '/user/:username',
  requireUser,
  getReaderPostsByUsername
)

export default router
