import express from 'express'
import multer from 'multer'
import { requireAdmin } from '../middleware/auth.middleware.js'
import {
  createSlide,
  deleteSlide,
  getSlideActivityLogs,
  getSlides,
  updateSlide,
} from '../controllers/slides.controller.js'

const router = express.Router()

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB max for one slide image
  },
})

router.get('/', getSlides)
router.get('/records', requireAdmin, getSlideActivityLogs)
router.post('/', requireAdmin, upload.single('image'), createSlide)
router.put('/:id', requireAdmin, upload.single('image'), updateSlide)
router.delete('/:id', requireAdmin, deleteSlide)

export default router
