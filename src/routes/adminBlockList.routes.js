import express from 'express'
import {
  createBlockedWord,
  deleteBlockedWord,
  getBlockedWordRecords,
  getBlockedWords,
  updateAllBlockedWordsStatus,
  updateBlockedWord,
} from '../controllers/adminBlockList.controller.js'
import {
  createReaderCommentBlock,
  getReaderCommentBlockRecords,
  getReaderCommentBlocks,
  searchReadersForBlock,
  unblockReaderComment,
} from '../controllers/adminReaderBlocks.controller.js'
import {
  getHiddenCommentReviews,
  keepHiddenComment,
  restoreHiddenComment,
} from '../controllers/adminHiddenCommentReviews.controller.js'
import { requireAdmin } from '../middleware/auth.middleware.js'

const router = express.Router()

router.get('/words', requireAdmin, getBlockedWords)
router.get('/records', requireAdmin, getBlockedWordRecords)
router.post('/words', requireAdmin, createBlockedWord)
router.patch('/words/toggle-all', requireAdmin, updateAllBlockedWordsStatus)
router.patch('/words/:wordId', requireAdmin, updateBlockedWord)
router.delete('/words/:wordId', requireAdmin, deleteBlockedWord)

router.get('/readers/search', requireAdmin, searchReadersForBlock)
router.get('/readers/blocks', requireAdmin, getReaderCommentBlocks)
router.post('/readers/blocks', requireAdmin, createReaderCommentBlock)
router.patch('/readers/blocks/:blockId/unblock', requireAdmin, unblockReaderComment)
router.get('/readers/records', requireAdmin, getReaderCommentBlockRecords)

router.get('/readers/hidden-comments', requireAdmin, getHiddenCommentReviews)
router.patch('/readers/hidden-comments/:reviewId/restore', requireAdmin, restoreHiddenComment)
router.patch('/readers/hidden-comments/:reviewId/keep-hidden', requireAdmin, keepHiddenComment)

export default router
