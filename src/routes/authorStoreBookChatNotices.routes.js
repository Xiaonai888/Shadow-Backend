import express from 'express'
import { requireUser } from '../middleware/user.middleware.js'
import { createRateLimit } from '../middleware/rateLimit.middleware.js'
import {
  getConversationBookNotices,
  markConversationBookNoticeSeen,
} from '../controllers/authorStoreBookChatNotices.controller.js'

const router = express.Router()
const readLimit = createRateLimit({
  key: 'book-chat-notices-read',
  windowMs: 60 * 1000,
  max: 30,
  identity: (req) => req.user?.user_id,
})
const writeLimit = createRateLimit({
  key: 'book-chat-notices-write',
  windowMs: 60 * 1000,
  max: 15,
  identity: (req) => req.user?.user_id,
})

router.use(requireUser)
router.get('/conversations/:conversationId/book-notices', readLimit, getConversationBookNotices)
router.post('/conversations/:conversationId/book-notices/:noticeId/seen', writeLimit, markConversationBookNoticeSeen)

export default router
