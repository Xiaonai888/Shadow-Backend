import express from 'express'
import multer from 'multer'
import { requireUser } from '../middleware/user.middleware.js'
import {
  getMyAuthorStorageQuota,
  uploadMyAuthorProfileImage,
} from '../controllers/authorMedia.controller.js'

const router = express.Router()

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 2 * 1024 * 1024,
  },
})

router.get('/storage', requireUser, getMyAuthorStorageQuota)
router.post('/profile-image', requireUser, upload.single('image'), uploadMyAuthorProfileImage)

export default router
