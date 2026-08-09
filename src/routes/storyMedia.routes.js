import express from 'express'
import multer from 'multer'
import { uploadStoryImage } from '../controllers/storyMedia.controller.js'
import { requireUser } from '../middleware/user.middleware.js'

const router = express.Router()

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024,
  },
})

router.post('/upload-image', requireUser, (req, res, next) => {
  upload.single('image')(req, res, (error) => {
    if (!error) return next()
    const status = error.code === 'LIMIT_FILE_SIZE' ? 413 : 400
    return res.status(status).json({ ok: false, code: error.code || 'UPLOAD_ERROR', message: error.message })
  })
}, uploadStoryImage)

export default router
