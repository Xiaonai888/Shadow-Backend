import express from 'express'
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

const router = express.Router()
const feedRequestsInFlight = new Map()
const FEED_IN_FLIGHT_LIMIT = 200

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

router.get('/feed', requireUser, coalesceReaderPostsFeed, getReaderPostsFeed)
router.get('/me', requireUser, getMyReaderPosts)
router.get('/:postId', requireUser, requirePrivateReaderPostAccess, getReaderPostById)
router.post('/me', requireUser, createMyReaderPost)
router.patch('/me/:postId', requireUser, updateMyReaderPost)
router.delete('/me/:postId', requireUser, deleteMyReaderPost)

router.get(
  '/:postId/reactions',
  requireUser,
  requirePrivateReaderPostAccess,
  getReaderPostReactions
)

router.get(
  '/:postId/reaction',
  requireUser,
  requirePrivateReaderPostAccess,
  getReaderPostReactionStatus
)
router.post(
  '/:postId/reaction',
  requireUser,
  requirePrivateReaderPostAccess,
  setReaderPostReaction
)

router.get(
  '/:postId/comments',
  requireUser,
  requirePrivateReaderPostAccess,
  getReaderPostComments
)
router.post(
  '/:postId/comments',
  requireUser,
  requirePrivateReaderPostAccess,
  createReaderPostComment
)
router.patch(
  '/comments/:commentId',
  requireUser,
  requirePrivateReaderPostAccess,
  updateOwnReaderPostComment
)
router.delete(
  '/comments/:commentId',
  requireUser,
  requirePrivateReaderPostAccess,
  deleteOwnReaderPostComment
)
router.post(
  '/comments/:commentId/like',
  requireUser,
  requirePrivateReaderPostAccess,
  toggleReaderPostCommentLike
)

router.get(
  '/comments/:commentId/replies',
  requireUser,
  requirePrivateReaderPostAccess,
  getReaderPostCommentReplies
)

router.get(
  '/:postId/echoes',
  requireUser,
  requirePrivateReaderPostAccess,
  getReaderPostEchoes
)
router.post(
  '/:postId/echoes',
  requireUser,
  requirePrivateReaderPostAccess,
  createReaderPostEcho
)


router.get(
  '/user/:username',
  requireUser,
  getReaderPostsByUsername
)

export default router
