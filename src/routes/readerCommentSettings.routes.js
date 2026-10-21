import express from 'express'
import { requireUser } from '../middleware/user.middleware.js'
import {
  getMyReaderCommentSettings,
  updateMyReaderCommentSettings,
} from '../controllers/readerCommentSettings.controller.js'

const router = express.Router()

router.get('/', requireUser, getMyReaderCommentSettings)
router.put('/', requireUser, updateMyReaderCommentSettings)

export default router
