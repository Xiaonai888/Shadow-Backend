import express from 'express'
import { rateLimit } from 'express-rate-limit'
import { requireUser } from '../middleware/user.middleware.js'
import {
  getMyReaderHiddenWords,
  addMyReaderHiddenWord,
  deleteMyReaderHiddenWord,
} from '../controllers/readerHiddenWords.controller.js'

const router = express.Router()

const hiddenWordsPreAuthLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 1200,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
})

const hiddenWordsReadLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req) => String(req.user?.user_id || req.user?.id || req.user?.session_id || 'unauthenticated'),
})

const hiddenWordsWriteLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req) => String(req.user?.user_id || req.user?.id || req.user?.session_id || 'unauthenticated'),
})

router.get('/', hiddenWordsPreAuthLimit, requireUser, hiddenWordsReadLimit, getMyReaderHiddenWords)
router.post('/', hiddenWordsPreAuthLimit, requireUser, hiddenWordsWriteLimit, addMyReaderHiddenWord)
router.delete('/:wordId', hiddenWordsPreAuthLimit, requireUser, hiddenWordsWriteLimit, deleteMyReaderHiddenWord)

export default router
