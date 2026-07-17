import express from 'express'
import multer from 'multer'
import {
  createMyReaderStory,
  deleteMyReaderStory,
  getMyReaderStories,
  recordReaderStoryView,
} from '../controllers/readerStories.controller.js'
import {
  requireUser,
} from '../middleware/user.middleware.js'

const router = express.Router()

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 30 * 1024 * 1024,
    files: 1,
  },
})

function uploadStoryMedia(
  req,
  res,
  next
) {
  upload.single('media')(
    req,
    res,
    (error) => {
      if (!error) return next()

      if (
        error.code ===
        'LIMIT_FILE_SIZE'
      ) {
        return res.status(413).json({
          ok: false,
          code:
            'STORY_MEDIA_TOO_LARGE',
          message:
            'Story media must be 30 MB or smaller',
        })
      }

      return res.status(400).json({
        ok: false,
        code:
          'STORY_MEDIA_UPLOAD_INVALID',
        message:
          error.message ||
          'Invalid story media upload',
      })
    }
  )
}

router.get(
  '/me',
  requireUser,
  getMyReaderStories
)

router.post(
  '/me',
  requireUser,
  uploadStoryMedia,
  createMyReaderStory
)

router.delete(
  '/me/:storyId',
  requireUser,
  deleteMyReaderStory
)

router.post(
  '/:storyId/view',
  requireUser,
  recordReaderStoryView
)

export default router
