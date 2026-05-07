import express from 'express'
import multer from 'multer'
import {
  createSlide,
  deleteSlide,
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
router.post('/', upload.single('image'), createSlide)
router.put('/:id', upload.single('image'), updateSlide)
router.delete('/:id', deleteSlide)

export default router
