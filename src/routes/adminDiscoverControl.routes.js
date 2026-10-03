import express from 'express'
import { requireAdmin } from '../middleware/auth.middleware.js'
import {
  addDiscoverControlAuthor,
  getDiscoverControlAuthors,
  removeDiscoverControlAuthor,
  searchDiscoverControlAuthors,
} from '../controllers/adminDiscoverControl.controller.js'

const router = express.Router()

router.use(requireAdmin)

router.get('/authors', getDiscoverControlAuthors)
router.get('/search', searchDiscoverControlAuthors)
router.post('/authors', addDiscoverControlAuthor)
router.delete('/authors/:authorPageId', removeDiscoverControlAuthor)

export default router
