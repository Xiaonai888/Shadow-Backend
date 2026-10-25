import express from 'express'
import { requireUser } from '../middleware/user.middleware.js'
import {
  getConversationBookOrders,
  markConversationBookOrderPopupSeen,
} from '../controllers/authorStoreBookChat.controller.js'

const router = express.Router()

router.use(requireUser)
router.get('/conversations/:conversationId/book-orders', getConversationBookOrders)
router.post('/conversations/:conversationId/book-orders/:orderId/popup-seen', markConversationBookOrderPopupSeen)

export default router
