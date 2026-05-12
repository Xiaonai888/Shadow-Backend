import express from 'express'
import { requireAdmin } from '../middleware/auth.middleware.js'
import {
  createBook,
  createEpisode,
  deleteBook,
  deleteEpisode,
  getBookById,
  getBookEpisodes,
  getBooks,
  getEpisodeById,
  updateBook,
  updateEpisode,
} from '../controllers/books.controller.js'

const router = express.Router()

router.get('/', getBooks)
router.post('/', requireAdmin, createBook)

router.get('/episodes/:id', getEpisodeById)
router.put('/episodes/:id', requireAdmin, updateEpisode)
router.delete('/episodes/:id', requireAdmin, deleteEpisode)

router.get('/:id', getBookById)
router.put('/:id', requireAdmin, updateBook)
router.delete('/:id', requireAdmin, deleteBook)

router.get('/:id/episodes', getBookEpisodes)
router.post('/:id/episodes', requireAdmin, createEpisode)

export default router
