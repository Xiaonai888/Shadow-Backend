import express from 'express'
import jwt from 'jsonwebtoken'
import multer from 'multer'
import os from 'node:os'
import { unlink } from 'node:fs/promises'
import { rateLimit, ipKeyGenerator } from 'express-rate-limit'
import {
  createMyAuthorStory,
  deleteMyAuthorStory,
  finalizeMyAuthorStoryVideoUpload,
  getMyAuthorStories,
  getPublicAuthorStories,
  initMyAuthorStoryVideoUpload,
} from '../controllers/authorStories.controller.js'
import { getAuthorStoriesFeed } from '../controllers/authorStoriesFeed.controller.js'
import { recordAuthorStoryView } from '../controllers/authorStoryViews.controller.js'
import { saveMyAuthorStoryExtras } from '../controllers/storyExtras.controller.js'
import { enforceAuthorStoryDailyLimit } from '../middleware/storyDailyLimit.middleware.js'
import { requireUser } from '../middleware/user.middleware.js'
import path from 'node:path'

const router = express.Router()

const upload = multer({
  dest: os.tmpdir(),
  limits: {
    fileSize: 30 * 1024 * 1024,
    files: 1,
  },
})

const authorStoryRateLimitKey = (req) =>
  req.spamGuard?.identity_type === 'account' && req.spamGuard.guard_key
    ? req.spamGuard.guard_key
    : ipKeyGenerator(req.ip)

const authorStoryReadLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 900,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: authorStoryRateLimitKey,
  message: {
    ok: false,
    code: 'AUTHOR_STORY_READ_RATE_LIMIT',
    message: 'Too many story requests. Please retry shortly.',
  },
})

const authorStoryActionLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: authorStoryRateLimitKey,
  message: {
    ok: false,
    code: 'AUTHOR_STORY_ACTION_RATE_LIMIT',
    message: 'Too many story actions. Please retry shortly.',
  },
})

function optionalUser(req, res, next) {
  try {
    const authHeader = req.headers.authorization || ''
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''

    if (!token || !process.env.JWT_SECRET) return next()

    const decoded = jwt.verify(token, process.env.JWT_SECRET)

    if (decoded.type === 'reader') {
      req.user = decoded
    }

    return next()
  } catch {
    return next()
  }
}

async function removeTempFile(req) {
  const fileName = req.file?.filename
  if (typeof fileName !== 'string' || !/^[a-f0-9]{32}$/i.test(fileName)) return
  const expectedPath = path.join(os.tmpdir(), fileName)
  if (req.file.path !== expectedPath) return
  await unlink(expectedPath).catch(() => {})
}

function cleanupStoryMediaTemp(req, res, next) {
  let cleaned = false

  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    removeTempFile(req).catch(() => {})
  }

  res.once('finish', cleanup)
  res.once('close', cleanup)
  next()
}

function uploadStoryMedia(req, res, next) {
  upload.single('media')(req, res, (error) => {
    if (!error) return next()

    removeTempFile(req).catch(() => {})

    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({
        ok: false,
        code: 'STORY_MEDIA_TOO_LARGE',
        message: 'Story media must be 30 MB or smaller',
      })
    }

    return res.status(400).json({
      ok: false,
      code: 'STORY_MEDIA_UPLOAD_INVALID',
      message: error.message || 'Invalid story media upload',
    })
  })
}

router.get('/feed', authorStoryReadLimit, optionalUser, getAuthorStoriesFeed)
router.get('/me', authorStoryReadLimit, requireUser, getMyAuthorStories)

router.post(
  '/me/video-upload/init',
  authorStoryActionLimit,
  requireUser,
  enforceAuthorStoryDailyLimit,
  initMyAuthorStoryVideoUpload
)

router.post(
  '/me/video-upload/finalize',
  authorStoryActionLimit,
  requireUser,
  enforceAuthorStoryDailyLimit,
  finalizeMyAuthorStoryVideoUpload
)

router.post(
  '/me',
  authorStoryActionLimit,
  requireUser,
  enforceAuthorStoryDailyLimit,
  uploadStoryMedia,
  cleanupStoryMediaTemp,
  createMyAuthorStory
)
router.patch('/me/:storyId/extras', authorStoryActionLimit, requireUser, saveMyAuthorStoryExtras)
router.delete('/me/:storyId', authorStoryActionLimit, requireUser, deleteMyAuthorStory)
router.post('/:storyId/view', authorStoryActionLimit, requireUser, recordAuthorStoryView)
router.get('/page/:pageUsername', authorStoryReadLimit, getPublicAuthorStories)

export default router
