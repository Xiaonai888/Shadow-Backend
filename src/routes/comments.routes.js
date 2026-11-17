import express from 'express'
import {
  getLatestStoryComment,
  getEpisodeCommentTotals,
  createEpisodeComment,
  getEpisodeComments,
  getCommentReplies,
  getCommentThread,
  getStoryCommentEpisodeOptions,
  createStoryComment,
  getMyCommentActivities,
  getStoryComments,
  markMyAuthorCommentRead,
  moderateComment,
  toggleCommentLike,
  updateOwnComment,
} from '../controllers/comments.controller.js'
import { getMyAuthorUnreadCommentCount } from '../controllers/authorCommentUnread.controller.js'
import { getEpisodeHotCommentSummary } from '../controllers/episodeHotCommentSummary.controller.js'
import { requireUser } from '../middleware/user.middleware.js'
import { invalidatePublicStoriesCache } from '../services/publicStoriesResponseCache.service.js'

const router = express.Router()
const LATEST_STORY_COMMENT_TTL_MS = 8000
const LATEST_STORY_COMMENT_CACHE_LIMIT = 300
const latestStoryCommentCache = new Map()
const latestStoryCommentPending = new Map()
let latestStoryCommentGeneration = 0

function invalidateLatestStoryCommentCache() {
  latestStoryCommentGeneration += 1
  latestStoryCommentCache.clear()
}

function invalidateLatestStoryCommentAfterWrite(req, res, next) {
  res.once('finish', () => {
    if (res.statusCode >= 200 && res.statusCode < 300) {
      invalidateLatestStoryCommentCache()
    }
  })
  next()
}

function coalesceLatestStoryComment(req, res, next) {
  const storyId = String(req.params.storyId || '').trim()
  if (!storyId) return next()

  const generation = latestStoryCommentGeneration
  const key = `${generation}:${storyId}`
  const cached = latestStoryCommentCache.get(key)

  if (cached && cached.expiresAt > Date.now()) {
    res.set('Cache-Control', 'private, no-store')
    return res.status(200).json(cached.body)
  }
  if (cached) latestStoryCommentCache.delete(key)

  const inFlight = latestStoryCommentPending.get(key)
  if (inFlight) {
    inFlight.then((result) => {
      if (res.destroyed || res.writableEnded) return
      if (!result) return next()
      res.set('Cache-Control', 'private, no-store')
      res.status(result.status).json(result.body)
    })
    return
  }

  if (latestStoryCommentPending.size >= LATEST_STORY_COMMENT_CACHE_LIMIT) {
    return next()
  }

  let resolvePending
  const pending = new Promise((resolve) => {
    resolvePending = resolve
  })
  latestStoryCommentPending.set(key, pending)

  let settled = false
  const settle = (result) => {
    if (settled) return
    settled = true
    if (latestStoryCommentPending.get(key) === pending) {
      latestStoryCommentPending.delete(key)
    }
    resolvePending(result)
  }

  const originalJson = res.json.bind(res)
  res.json = (body) => {
    const status = Number(res.statusCode || 200)
    if (status === 200 && body?.ok === true && generation === latestStoryCommentGeneration) {
      if (latestStoryCommentCache.size >= LATEST_STORY_COMMENT_CACHE_LIMIT) {
        latestStoryCommentCache.delete(latestStoryCommentCache.keys().next().value)
      }
      latestStoryCommentCache.set(key, {
        body,
        expiresAt: Date.now() + LATEST_STORY_COMMENT_TTL_MS,
      })
    }
    settle({ status, body })
    res.set('Cache-Control', 'private, no-store')
    return originalJson(body)
  }

  res.once('close', () => settle(null))
  next()
}

function invalidateVisibleCommentCreate(req, res, next) {
  res.once('finish', () => {
    if (res.statusCode === 201) {
      invalidatePublicStoriesCache()
    }
  })

  next()
}

function invalidateCommentEditIfCountChanged(req, res, next) {
  res.once('finish', () => {
    if (res.statusCode === 202) {
      invalidatePublicStoriesCache()
    }
  })

  next()
}

function invalidateCommentModerationIfCountChanged(req, res, next) {
  const action = String(req.body?.action || '')
    .trim()
    .toLowerCase()

  if (action === 'hide' || action === 'unhide') {
    res.once('finish', () => {
      if (
        res.statusCode >= 200 &&
        res.statusCode < 300
      ) {
        invalidatePublicStoriesCache()
      }
    })
  }

  next()
}

router.get('/episode-totals', getEpisodeCommentTotals)
router.get('/episode/:episodeId', getEpisodeComments)
router.get('/episode/:episodeId/hot-summary', getEpisodeHotCommentSummary)
router.post(
  '/episode/:episodeId',
  requireUser,
  invalidateVisibleCommentCreate,
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
  coalesceLatestStoryComment,
  getLatestStoryComment
)
router.get('/story/:storyId', getStoryComments)
router.get('/story/:storyId/episode-options', requireUser, getStoryCommentEpisodeOptions)
router.post(
  '/story/:storyId',
  requireUser,
  invalidateVisibleCommentCreate,
  invalidateLatestStoryCommentAfterWrite,
  createStoryComment
)
router.get('/:commentId/replies', getCommentReplies)
router.get('/:commentId/thread', requireUser, getCommentThread)
router.patch(
  '/:commentId/author-read',
  requireUser,
  markMyAuthorCommentRead
)
router.post('/:commentId/like', requireUser, invalidateLatestStoryCommentAfterWrite, toggleCommentLike)
router.patch(
  '/:commentId',
  requireUser,
  invalidateCommentEditIfCountChanged,
  invalidateLatestStoryCommentAfterWrite,
  updateOwnComment
)
router.patch(
  '/:commentId/moderate',
  requireUser,
  invalidateCommentModerationIfCountChanged,
  invalidateLatestStoryCommentAfterWrite,
  moderateComment
)

export default router
