import express from 'express'
import { rateLimit } from 'express-rate-limit'
import { createHash } from 'node:crypto'
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
import { requirePrivateReaderPostAccess } from '../services/readerPostPrivacy.service.js'
import { getPendingReaderPostComments, reviewPendingReaderPostComments } from '../controllers/readerPostCommentModeration.controller.js'
import { getMyReaderPostTags } from '../controllers/readerPostTags.controller.js'

const router = express.Router()
const feedRequestsInFlight = new Map()
const FEED_IN_FLIGHT_LIMIT = 200

const readerPostsPreAuthLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 3000,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
})

const readerPostIdentity = (req) => String(
  req.user?.user_id || req.user?.id || req.user?.session_id || 'unauthenticated'
)

const readerPostsReadLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 300,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: readerPostIdentity,
})

const readerPostsWriteLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: readerPostIdentity,
})

function coalesceReaderPostsFeed(req, res, next) {
  const userId = String(req.user?.user_id || req.user?.id || '').trim()
  const authorization = String(req.headers.authorization || '')
  if (!userId || !authorization) return next()

  const key = createHash('sha256')
    .update(JSON.stringify([userId, authorization, req.originalUrl]))
    .digest('hex')
  const existing = feedRequestsInFlight.get(key)

  if (existing) {
    existing.promise.then((result) => {
      if (res.headersSent || res.writableEnded || res.destroyed) return
      if (!result) return next()
      res.set('Cache-Control', 'private, no-store')
      return res.status(result.status).json(result.body)
    })
    return
  }

  if (feedRequestsInFlight.size >= FEED_IN_FLIGHT_LIMIT) return next()

  let resolveRequest
  const pending = new Promise((resolve) => {
    resolveRequest = resolve
  })
  feedRequestsInFlight.set(key, { promise: pending })

  let settled = false
  const finish = (result) => {
    if (settled) return
    settled = true
    if (feedRequestsInFlight.get(key)?.promise === pending) {
      feedRequestsInFlight.delete(key)
    }
    resolveRequest(result)
  }

  const originalJson = res.json.bind(res)
  res.json = (body) => {
    const status = res.statusCode || 200
    finish({ status, body })
    return originalJson(body)
  }

  res.once('close', () => finish(null))
  next()
}

router.get('/feed', readerPostsPreAuthLimit, requireUser, readerPostsReadLimit, coalesceReaderPostsFeed, getReaderPostsFeed)
router.get('/me', readerPostsPreAuthLimit, requireUser, readerPostsReadLimit, coalesceReaderPostsFeed, getMyReaderPosts)
router.get('/me/:postId/tags', readerPostsPreAuthLimit, requireUser, readerPostsReadLimit, getMyReaderPostTags)
router.get('/:postId/comments/pending', readerPostsPreAuthLimit, requireUser, readerPostsReadLimit, getPendingReaderPostComments)
router.post('/:postId/comments/review', readerPostsPreAuthLimit, requireUser, readerPostsWriteLimit, reviewPendingReaderPostComments)
router.get('/:postId', readerPostsPreAuthLimit, requireUser, readerPostsReadLimit, requirePrivateReaderPostAccess, getReaderPostById)
router.post('/me', readerPostsPreAuthLimit, requireUser, readerPostsWriteLimit, createMyReaderPost)
router.patch('/me/:postId', readerPostsPreAuthLimit, requireUser, readerPostsWriteLimit, updateMyReaderPost)
router.delete('/me/:postId', readerPostsPreAuthLimit, requireUser, readerPostsWriteLimit, deleteMyReaderPost)

router.get(
  '/:postId/reactions',
  readerPostsPreAuthLimit,
  requireUser,
  readerPostsReadLimit,
  requirePrivateReaderPostAccess,
  getReaderPostReactions
)

router.get(
  '/:postId/reaction',
  readerPostsPreAuthLimit,
  requireUser,
  readerPostsReadLimit,
  requirePrivateReaderPostAccess,
  getReaderPostReactionStatus
)
router.post(
  '/:postId/reaction',
  readerPostsPreAuthLimit,
  requireUser,
  readerPostsWriteLimit,
  requirePrivateReaderPostAccess,
  setReaderPostReaction
)

router.get(
  '/:postId/comments',
  readerPostsPreAuthLimit,
  requireUser,
  readerPostsReadLimit,
  requirePrivateReaderPostAccess,
  getReaderPostComments
)
router.post(
  '/:postId/comments',
  readerPostsPreAuthLimit,
  requireUser,
  readerPostsWriteLimit,
  requirePrivateReaderPostAccess,
  createReaderPostComment
)
router.patch(
  '/comments/:commentId',
  readerPostsPreAuthLimit,
  requireUser,
  readerPostsWriteLimit,
  requirePrivateReaderPostAccess,
  updateOwnReaderPostComment
)
router.delete(
  '/comments/:commentId',
  readerPostsPreAuthLimit,
  requireUser,
  readerPostsWriteLimit,
  requirePrivateReaderPostAccess,
  deleteOwnReaderPostComment
)
router.post(
  '/comments/:commentId/like',
  readerPostsPreAuthLimit,
  requireUser,
  readerPostsWriteLimit,
  requirePrivateReaderPostAccess,
  toggleReaderPostCommentLike
)

router.get(
  '/comments/:commentId/replies',
  readerPostsPreAuthLimit,
  requireUser,
  readerPostsReadLimit,
  requirePrivateReaderPostAccess,
  getReaderPostCommentReplies
)

router.get(
  '/:postId/echoes',
  readerPostsPreAuthLimit,
  requireUser,
  readerPostsReadLimit,
  requirePrivateReaderPostAccess,
  getReaderPostEchoes
)
router.post(
  '/:postId/echoes',
  readerPostsPreAuthLimit,
  requireUser,
  readerPostsWriteLimit,
  requirePrivateReaderPostAccess,
  createReaderPostEcho
)


router.get(
  '/user/:username',
  readerPostsPreAuthLimit,
  requireUser,
  readerPostsReadLimit,
  coalesceReaderPostsFeed,
  getReaderPostsByUsername
)

export default router
