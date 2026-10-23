import express from 'express'
import { createHash } from 'node:crypto'
import { rateLimit } from 'express-rate-limit'
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

const readerPostReadLimit = rateLimit({
  windowMs: 60000,
  limit: 900,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req) => String(req.user?.user_id || req.user?.id || 'unauthenticated'),
  message: {
    ok: false,
    code: 'READER_POST_READ_RATE_LIMIT',
    message: 'Too many post requests. Please try again shortly.',
  },
})

const readerPostWriteLimit = rateLimit({
  windowMs: 60000,
  limit: 120,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req) => String(req.user?.user_id || req.user?.id || 'unauthenticated'),
  message: {
    ok: false,
    code: 'READER_POST_WRITE_RATE_LIMIT',
    message: 'Too many post actions. Please try again shortly.',
  },
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

router.get('/feed', requireUser, readerPostReadLimit, coalesceReaderPostsFeed, getReaderPostsFeed)
router.get('/me', requireUser, readerPostReadLimit, getMyReaderPosts)
router.get('/me/:postId/tags', requireUser, readerPostReadLimit, getMyReaderPostTags)
router.get('/:postId/comments/pending', requireUser, readerPostReadLimit, getPendingReaderPostComments)
router.post('/:postId/comments/review', requireUser, readerPostWriteLimit, reviewPendingReaderPostComments)
router.get('/:postId', requireUser, readerPostReadLimit, requirePrivateReaderPostAccess, getReaderPostById)
router.post('/me', requireUser, readerPostWriteLimit, createMyReaderPost)
router.patch('/me/:postId', requireUser, readerPostWriteLimit, updateMyReaderPost)
router.delete('/me/:postId', requireUser, readerPostWriteLimit, deleteMyReaderPost)

router.get(
  '/:postId/reactions',
  requireUser,
  readerPostReadLimit,
  requirePrivateReaderPostAccess,
  getReaderPostReactions
)

router.get(
  '/:postId/reaction',
  requireUser,
  readerPostReadLimit,
  requirePrivateReaderPostAccess,
  getReaderPostReactionStatus
)
router.post(
  '/:postId/reaction',
  requireUser,
  readerPostWriteLimit,
  requirePrivateReaderPostAccess,
  setReaderPostReaction
)

router.get(
  '/:postId/comments',
  requireUser,
  readerPostReadLimit,
  requirePrivateReaderPostAccess,
  getReaderPostComments
)
router.post(
  '/:postId/comments',
  requireUser,
  readerPostWriteLimit,
  requirePrivateReaderPostAccess,
  createReaderPostComment
)
router.patch(
  '/comments/:commentId',
  requireUser,
  readerPostWriteLimit,
  requirePrivateReaderPostAccess,
  updateOwnReaderPostComment
)
router.delete(
  '/comments/:commentId',
  requireUser,
  readerPostWriteLimit,
  requirePrivateReaderPostAccess,
  deleteOwnReaderPostComment
)
router.post(
  '/comments/:commentId/like',
  requireUser,
  readerPostWriteLimit,
  requirePrivateReaderPostAccess,
  toggleReaderPostCommentLike
)

router.get(
  '/comments/:commentId/replies',
  requireUser,
  readerPostReadLimit,
  requirePrivateReaderPostAccess,
  getReaderPostCommentReplies
)

router.get(
  '/:postId/echoes',
  requireUser,
  readerPostReadLimit,
  requirePrivateReaderPostAccess,
  getReaderPostEchoes
)
router.post(
  '/:postId/echoes',
  requireUser,
  readerPostWriteLimit,
  requirePrivateReaderPostAccess,
  createReaderPostEcho
)


router.get(
  '/user/:username',
  requireUser,
  readerPostReadLimit,
  getReaderPostsByUsername
)

export default router
