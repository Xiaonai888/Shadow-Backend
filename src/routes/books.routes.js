import express from 'express'
import {
  getBookById,
  getBookEpisodes,
  getBooks,
  getEpisodeById,
} from '../controllers/books.controller.js'

const router = express.Router()

router.get('/', getBooks)
router.get('/:id', getBookById)
router.get('/:id/episodes', getBookEpisodes)
router.get('/episodes/:id', getEpisodeById)

export default router
