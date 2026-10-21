import express from 'express'
import { requireUser } from '../middleware/user.middleware.js'
import {
  getMyReaderMessagesRepliesSettings,
  updateMyReaderMessagesRepliesSettings,
} from '../controllers/readerMessagesRepliesSettings.controller.js'

const router = express.Router()

router.get('/', requireUser, getMyReaderMessagesRepliesSettings)
router.put('/', requireUser, updateMyReaderMessagesRepliesSettings)

export default router
