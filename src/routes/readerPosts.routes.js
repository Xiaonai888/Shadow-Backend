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

router.use(readerPostsPreAuthLimit)

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

router.get('/feed', requireUser, readerPostsReadLimit, coalesceReaderPostsFeed, getReaderPostsFeed)
router.get('/me', requireUser, readerPostsReadLimit, getMyReaderPosts)
router.get('/me/:postId/tags', requireUser, readerPostsReadLimit, getMyReaderPostTags)
router.get('/:postId/comments/pending', requireUser, readerPostsReadLimit, getPendingReaderPostComments)
router.post('/:postId/comments/review', requireUser, readerPostsWriteLimit, reviewPendingReaderPostComments)
router.get('/:postId', requireUser, readerPostsReadLimit, requirePrivateReaderPostAccess, getReaderPostById)
router.post('/me', requireUser, readerPostsWriteLimit, createMyReaderPost)
router.patch('/me/:postId', requireUser, readerPostsWriteLimit, updateMyReaderPost)
router.delete('/me/:postId', requireUser, readerPostsWriteLimit, deleteMyReaderPost)

router.get(
  '/:postId/reactions',
  requireUser,
  readerPostsReadLimit,
  requirePrivateReaderPostAccess,
  getReaderPostReactions
)

router.get(
  '/:postId/reaction',
  requireUser,
  readerPostsReadLimit,
  requirePrivateReaderPostAccess,
  getReaderPostReactionStatus
)
router.post(
  '/:postId/reaction',
  requireUser,
  readerPostsWriteLimit,
  requirePrivateReaderPostAccess,
  setReaderPostReaction
)

router.get(
  '/:postId/comments',
  requireUser,
  readerPostsReadLimit,
  requirePrivateReaderPostAccess,
  getReaderPostComments
)
router.post(
  '/:postId/comments',
  requireUser,
  readerPostsWriteLimit,
  requirePrivateReaderPostAccess,
  createReaderPostComment
)
router.patch(
  '/comments/:commentId',
  requireUser,
  readerPostsWriteLimit,
  requirePrivateReaderPostAccess,
  updateOwnReaderPostComment
)
router.delete(
  '/comments/:commentId',
  requireUser,
  readerPostsWriteLimit,
  requirePrivateReaderPostAccess,
  deleteOwnReaderPostComment
)
router.post(
  '/comments/:commentId/like',
  requireUser,
  readerPostsWriteLimit,
  requirePrivateReaderPostAccess,
  toggleReaderPostCommentLike
)

router.get(
  '/comments/:commentId/replies',
  requireUser,
  readerPostsReadLimit,
  requirePrivateReaderPostAccess,
  getReaderPostCommentReplies
)

router.get(
  '/:postId/echoes',
  requireUser,
  readerPostsReadLimit,
  requirePrivateReaderPostAccess,
  getReaderPostEchoes
)
router.post(
  '/:postId/echoes',
  requireUser,
  readerPostsWriteLimit,
  requirePrivateReaderPostAccess,
  createReaderPostEcho
)


router.get(
  '/user/:username',
  requireUser,
  readerPostsReadLimit,
  getReaderPostsByUsername
)

export default router
