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
