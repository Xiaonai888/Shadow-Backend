import express from 'express'
import multer from 'multer'
import os from 'node:os'
import { unlink } from 'node:fs/promises'
import { rateLimit, ipKeyGenerator } from 'express-rate-limit'
import {
  createMyReaderStory,
  deleteMyReaderStory,
  finalizeMyReaderStoryVideoUpload,
  getMyReaderStories,
  initMyReaderStoryVideoUpload,
  recordReaderStoryView,
} from '../controllers/readerStories.controller.js'
import { repostReaderStory } from '../controllers/repostReaderStory.controller.js'
import {
  saveMyReaderStoryExtras,
} from '../controllers/storyExtras.controller.js'
import {
  enforceReaderStoryDailyLimit,
} from '../middleware/storyDailyLimit.middleware.js'
import {
  requireUser,
} from '../middleware/user.middleware.js'
import path from 'node:path'

const router = express.Router()

const upload = multer({
  dest: os.tmpdir(),
  limits: {
    fileSize: 30 * 1024 * 1024,
    files: 1,
  },
})

const readerStoryRateLimitKey = (req) =>
  req.spamGuard?.identity_type === 'account' && req.spamGuard.guard_key
    ? req.spamGuard.guard_key
    : ipKeyGenerator(req.ip)

const readerStoryReadLimit = rateLimit({
  windowMs: 60000,
  limit: 900,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: readerStoryRateLimitKey,
  message: {
    ok: false,
    code: 'READER_STORY_READ_RATE_LIMIT',
    message: 'Too many story requests. Please retry shortly.',
  },
})

const readerStoryActionLimit = rateLimit({
  windowMs: 60000,
  limit: 120,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: readerStoryRateLimitKey,
  message: {
    ok: false,
    code: 'READER_STORY_ACTION_RATE_LIMIT',
    message: 'Too many story actions. Please retry shortly.',
  },
})

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

router.get(
  '/me',
  readerStoryReadLimit,
  requireUser,
  getMyReaderStories
)

router.post(
  '/me/video-upload/init',
  readerStoryActionLimit,
  requireUser,
  enforceReaderStoryDailyLimit,
  initMyReaderStoryVideoUpload
)

router.post(
  '/me/video-upload/finalize',
  readerStoryActionLimit,
  requireUser,
  enforceReaderStoryDailyLimit,
  finalizeMyReaderStoryVideoUpload
)

router.post(
  '/me',
  readerStoryActionLimit,
  requireUser,
  enforceReaderStoryDailyLimit,
  uploadStoryMedia,
  cleanupStoryMediaTemp,
  createMyReaderStory
)

router.post(
  '/me/repost',
  readerStoryActionLimit,
  requireUser,
  enforceReaderStoryDailyLimit,
  repostReaderStory
)

router.patch(
  '/me/:storyId/extras',
  readerStoryActionLimit,
  requireUser,
  saveMyReaderStoryExtras
)

router.delete(
  '/me/:storyId',
  readerStoryActionLimit,
  requireUser,
  deleteMyReaderStory
)

router.post(
  '/:storyId/view',
  readerStoryActionLimit,
  requireUser,
  recordReaderStoryView
)

export default router
