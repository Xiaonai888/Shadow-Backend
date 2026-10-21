import express from 'express'
import { requireUser } from '../middleware/user.middleware.js'
import {
  getMyReaderHiddenWords,
  addMyReaderHiddenWord,
  deleteMyReaderHiddenWord,
} from '../controllers/readerHiddenWords.controller.js'

const router = express.Router()

router.get('/', requireUser, getMyReaderHiddenWords)
router.post('/', requireUser, addMyReaderHiddenWord)
router.delete('/:wordId', requireUser, deleteMyReaderHiddenWord)

export default router
