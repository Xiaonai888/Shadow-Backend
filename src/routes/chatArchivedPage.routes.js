import express from 'express'
import { createRateLimit } from '../middleware/rateLimit.middleware.js'
import { ChatServiceError } from '../services/chat.service.js'
import { listArchivedChatPage } from '../services/chatArchivedPage.service.js'

const router = express.Router()
const archivedReadLimit = createRateLimit({
  key: 'chat-archived-paginated',
  windowMs: 60 * 1000,
  max: 30,
  identity: (req) => req.user?.user_id,
})

router.get('/conversations/archived-page', archivedReadLimit, async (req, res) => {
  try {
    const result = await listArchivedChatPage({
      userId: req.user?.user_id,
      role: req.query?.role,
      page: req.query?.page || 1,
      limit: req.query?.limit || 20,
    })
    return res.status(200).json({ ok: true, ...result })
  } catch (error) {
    console.error('LIST ARCHIVED CHAT PAGE ERROR:', error?.cause?.message || error?.message)
    const known = error instanceof ChatServiceError
    return res.status(known ? error.status : 500).json({
      ok: false,
      code: known ? error.code : 'CHAT_SERVER_ERROR',
      message: known ? error.message : 'Chat is temporarily unavailable',
    })
  }
})

export default router
