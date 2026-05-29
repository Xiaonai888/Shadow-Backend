import express from 'express'
import multer from 'multer'
import { uploadStoryImage } from '../controllers/storyMedia.controller.js'
import { requireUser } from '../middleware/user.middleware.js'
import tasksRoutes from './src/routes/tasks.routes.js'

const router = express.Router()

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 8 * 1024 * 1024,
  },
})

app.use('/api/tasks', tasksRoutes)

router.post('/upload-image', requireUser, upload.single('image'), uploadStoryImage)

export default router
