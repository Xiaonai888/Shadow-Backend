import express from 'express'
import {
  createBlockedWord,
  deleteBlockedWord,
  getBlockedWordRecords,
  getBlockedWords,
  updateBlockedWord,
} from '../controllers/adminBlockList.controller.js'
import {
  createReaderCommentBlock,
  getReaderCommentBlockRecords,
  getReaderCommentBlocks,
  searchReadersForBlock,
  unblockReaderComment,
} from '../controllers/adminReaderBlocks.controller.js'
import { requireAdmin } from '../middleware/auth.middleware.js'

const router = express.Router()

router.get('/words', requireAdmin, getBlockedWords)
router.get('/records', requireAdmin, getBlockedWordRecords)
router.post('/words', requireAdmin, createBlockedWord)
router.patch('/words/:wordId', requireAdmin, updateBlockedWord)
router.delete('/words/:wordId', requireAdmin, deleteBlockedWord)

router.get('/readers/search', requireAdmin, searchReadersForBlock)
router.get('/readers/blocks', requireAdmin, getReaderCommentBlocks)
router.post('/readers/blocks', requireAdmin, createReaderCommentBlock)
router.patch('/readers/blocks/:blockId/unblock', requireAdmin, unblockReaderComment)
router.get('/readers/records', requireAdmin, getReaderCommentBlockRecords)

export default router
