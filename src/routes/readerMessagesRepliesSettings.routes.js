import express from 'express'
import { rateLimit } from 'express-rate-limit'
import { requireUser } from '../middleware/user.middleware.js'
import {
  getMyReaderMessagesRepliesSettings,
  updateMyReaderMessagesRepliesSettings,
} from '../controllers/readerMessagesRepliesSettings.controller.js'

const router = express.Router()

const readerMessagesRepliesReadLimit = rateLimit({
  windowMs: 60000,
  limit: 120,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req) => String(req.user?.user_id || req.user?.id || 'unauthenticated'),
  message: {
    ok: false,
    code: 'READER_MESSAGES_REPLIES_READ_RATE_LIMIT',
    message: 'Too many settings requests. Please try again shortly.',
  },
})

const readerMessagesRepliesWriteLimit = rateLimit({
  windowMs: 60000,
  limit: 30,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req) => String(req.user?.user_id || req.user?.id || 'unauthenticated'),
  message: {
    ok: false,
    code: 'READER_MESSAGES_REPLIES_WRITE_RATE_LIMIT',
    message: 'Too many settings updates. Please try again shortly.',
  },
})

router.get('/', requireUser, readerMessagesRepliesReadLimit, getMyReaderMessagesRepliesSettings)
router.put('/', requireUser, readerMessagesRepliesWriteLimit, updateMyReaderMessagesRepliesSettings)

export default router
