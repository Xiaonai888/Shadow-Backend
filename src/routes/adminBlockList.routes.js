import express from 'express'
import { rateLimit } from 'express-rate-limit'
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

const adminBlockListReadLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 600,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {
    ok: false,
    code: 'ADMIN_BLOCK_LIST_READ_RATE_LIMIT',
    message: 'Too many block list requests. Please retry shortly.',
  },
})

const adminBlockListWriteLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {
    ok: false,
    code: 'ADMIN_BLOCK_LIST_WRITE_RATE_LIMIT',
    message: 'Too many block list changes. Please retry shortly.',
  },
})

router.get('/words', adminBlockListReadLimit, requireAdmin, getBlockedWords)
router.get('/records', adminBlockListReadLimit, requireAdmin, getBlockedWordRecords)
router.post('/words', adminBlockListWriteLimit, requireAdmin, createBlockedWord)
router.patch('/words/toggle-all', adminBlockListWriteLimit, requireAdmin, updateAllBlockedWordsStatus)
router.patch('/words/:wordId', adminBlockListWriteLimit, requireAdmin, updateBlockedWord)
router.delete('/words/:wordId', adminBlockListWriteLimit, requireAdmin, deleteBlockedWord)

router.get('/readers/search', adminBlockListReadLimit, requireAdmin, searchReadersForBlock)
router.get('/readers/blocks', adminBlockListReadLimit, requireAdmin, getReaderCommentBlocks)
router.post('/readers/blocks', adminBlockListWriteLimit, requireAdmin, createReaderCommentBlock)
router.patch('/readers/blocks/:blockId/unblock', adminBlockListWriteLimit, requireAdmin, unblockReaderComment)
router.get('/readers/records', adminBlockListReadLimit, requireAdmin, getReaderCommentBlockRecords)

router.get('/readers/hidden-comments', adminBlockListReadLimit, requireAdmin, getHiddenCommentReviews)
router.patch('/readers/hidden-comments/:reviewId/restore', adminBlockListWriteLimit, requireAdmin, restoreHiddenComment)
router.patch('/readers/hidden-comments/:reviewId/keep-hidden', adminBlockListWriteLimit, requireAdmin, keepHiddenComment)

export default router
