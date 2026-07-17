import express from 'express'
import {
  getReadingProgress,
  saveReadingProgress,
} from '../controllers/readingProgress.controller.js'
import { requireUser } from '../middleware/user.middleware.js'

const router = express.Router()

router.get('/', requireUser, getReadingProgress)
router.post('/', requireUser, saveReadingProgress)

export default router
