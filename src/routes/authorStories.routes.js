import express from 'express'
import jwt from 'jsonwebtoken'
import multer from 'multer'
import {
  createMyAuthorStory,
  deleteMyAuthorStory,
  getMyAuthorStories,
  getPublicAuthorStories,
} from '../controllers/authorStories.controller.js'
import { getAuthorStoriesFeed } from '../controllers/authorStoriesFeed.controller.js'
import { recordAuthorStoryView } from '../controllers/authorStoryViews.controller.js'
import { requireUser } from '../middleware/user.middleware.js'

const router = express.Router()

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024,
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

function uploadStoryMedia(req, res, next) {
  upload.single('media')(req, res, (error) => {
    if (!error) return next()

    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({
        ok: false,
        code: 'STORY_MEDIA_TOO_LARGE',
        message: 'Story media must be 50 MB or smaller',
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
router.post('/me', requireUser, uploadStoryMedia, createMyAuthorStory)
router.delete('/me/:storyId', requireUser, deleteMyAuthorStory)
router.post('/:storyId/view', requireUser, recordAuthorStoryView)
router.get('/page/:pageUsername', getPublicAuthorStories)

export default router
