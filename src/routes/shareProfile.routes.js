import express from 'express'
import multer from 'multer'
import {
  deleteShareProfileCustomImage,
  uploadShareProfileCustomImage,
} from '../controllers/shareProfile.controller.js'
import { requireUser } from '../middleware/user.middleware.js'

const router = express.Router()

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 8 * 1024 * 1024,
  },
  fileFilter(req, file, callback) {
    if (!file.mimetype?.startsWith('image/')) {
      callback(new Error('Only image files are allowed'))
      return
    }

    callback(null, true)
  },
})

router.post(
  '/custom-image',
  requireUser,
  upload.single('image'),
  uploadShareProfileCustomImage
)
router.delete('/custom-image', requireUser, deleteShareProfileCustomImage)

export default router
