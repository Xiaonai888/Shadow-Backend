import express from 'express'
import { requireUser } from '../middleware/user.middleware.js'
import {
  createRateLimit as createIpLimiter,
  createRateLimit as createRateLimiter,
} from '../middleware/rateLimit.middleware.js'
import {
  getConversationBookNotices,
  markConversationBookNoticeSeen,
} from '../controllers/authorStoreBookChatNotices.controller.js'

const router = express.Router()

const readIpLimit = createIpLimiter({
  key: 'book-chat-notices-read-ip',
  windowMs: 60 * 1000,
  max: 180,
})

const writeIpLimit = createIpLimiter({
  key: 'book-chat-notices-write-ip',
  windowMs: 60 * 1000,
  max: 90,
})

const readLimit = createRateLimiter({
  key: 'book-chat-notices-read',
  windowMs: 60 * 1000,
  max: 30,
  identity: (req) => req.user?.user_id,
})

const writeLimit = createRateLimiter({
  key: 'book-chat-notices-write',
  windowMs: 60 * 1000,
  max: 15,
  identity: (req) => req.user?.user_id,
})

router.get('/conversations/:conversationId/book-notices', readIpLimit, requireUser, readLimit, getConversationBookNotices)
router.post('/conversations/:conversationId/book-notices/:noticeId/seen', writeIpLimit, requireUser, writeLimit, markConversationBookNoticeSeen)

export default router
