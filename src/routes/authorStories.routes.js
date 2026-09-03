import express from 'express'
import jwt from 'jsonwebtoken'
import multer from 'multer'
import os from 'node:os'
import { unlink } from 'node:fs/promises'
import {
  createMyAuthorStory,
  deleteMyAuthorStory,
  getMyAuthorStories,
  getPublicAuthorStories,
} from '../controllers/authorStories.controller.js'
import { getAuthorStoriesFeed } from '../controllers/authorStoriesFeed.controller.js'
import { recordAuthorStoryView } from '../controllers/authorStoryViews.controller.js'
import { saveMyAuthorStoryExtras } from '../controllers/storyExtras.controller.js'
import { enforceAuthorStoryDailyLimit } from '../middleware/storyDailyLimit.middleware.js'
import { requireUser } from '../middleware/user.middleware.js'

const router = express.Router()

const upload = multer({
  dest: os.tmpdir(),
  limits: {
    fileSize: 30 * 1024 * 1024,
    files: 1,
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
  if (!req.file?.path) return
  await unlink(req.file.path).catch(() => {})
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

router.get('/feed', optionalUser, getAuthorStoriesFeed)
router.get('/me', requireUser, getMyAuthorStories)
router.post(
  '/me',
  requireUser,
  enforceAuthorStoryDailyLimit,
  uploadStoryMedia,
  cleanupStoryMediaTemp,
  createMyAuthorStory
)
router.patch('/me/:storyId/extras', requireUser, saveMyAuthorStoryExtras)
router.delete('/me/:storyId', requireUser, deleteMyAuthorStory)
router.post('/:storyId/view', requireUser, recordAuthorStoryView)
router.get('/page/:pageUsername', getPublicAuthorStories)

export default router
