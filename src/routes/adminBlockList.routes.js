import express from 'express'
import {
  createBlockedWord,
  deleteBlockedWord,
  getBlockedWordRecords,
  getBlockedWords,
  updateBlockedWord,
} from '../controllers/adminBlockList.controller.js'
import { requireAdmin } from '../middleware/auth.middleware.js'

const router = express.Router()

router.get('/words', requireAdmin, getBlockedWords)
router.get('/records', requireAdmin, getBlockedWordRecords)
router.post('/words', requireAdmin, createBlockedWord)
router.patch('/words/:wordId', requireAdmin, updateBlockedWord)
router.delete('/words/:wordId', requireAdmin, deleteBlockedWord)

export default router
