import express from 'express'
import {
  createReaderAuthorRequestController,
  createReaderReaderRequestController,
  decideMessageRequestController,
  getConversationMessagesController,
  listMyConversationsController,
  markConversationReadController,
  sendConversationMessageController,
} from '../controllers/chat.controller.js'
import { searchChatUsersController } from '../controllers/chatUserSearch.controller.js'
import { requireUser } from '../middleware/user.middleware.js'
import { createSpamGuard } from '../middleware/spamGuard.middleware.js'

const router = express.Router()

const chatReadGuard = createSpamGuard({
  scope: 'chat_read',
  threshold: 180,
  windowSeconds: 60,
})

const chatWriteGuard = createSpamGuard({
  scope: 'chat_write',
  threshold: 30,
  windowSeconds: 60,
})

const chatRequestGuard = createSpamGuard({
  scope: 'chat_request',
  threshold: 5,
  windowSeconds: 60,
})

router.use(requireUser)

router.post(
  '/reader-author/requests',
  chatRequestGuard,
  createReaderAuthorRequestController
)

router.post(
  '/reader-reader/requests',
  chatRequestGuard,
  createReaderReaderRequestController
)

router.get(
  '/users/search',
  chatReadGuard,
  searchChatUsersController
)

router.get(
  '/conversations',
  chatReadGuard,
  listMyConversationsController
)

router.get(
  '/conversations/:conversationId/messages',
  chatReadGuard,
  getConversationMessagesController
)

router.post(
  '/conversations/:conversationId/messages',
  chatWriteGuard,
  sendConversationMessageController
)

router.patch(
  '/conversations/:conversationId/request',
  chatWriteGuard,
  decideMessageRequestController
)

router.patch(
  '/conversations/:conversationId/read',
  chatWriteGuard,
  markConversationReadController
)

export default router
