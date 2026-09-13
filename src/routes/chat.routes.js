import chatConversationManagementRoutes from './chatConversationManagement.routes.js'
import chatMessageActionsRoutes from './chatMessageActions.routes.js'
import express from 'express'
import {
  createReaderAuthorRequestController,
  createReaderReaderRequestController,
  decideMessageRequestController,
  getConversationMessagesController,
  listMyConversationsController,
  markConversationReadController,
  sendConversationMessageController,
  createGroupConversationController,
} from '../controllers/chat.controller.js'
import {
  blockConversationController,
  getConversationBlockStatusController,
  unblockConversationController,
} from '../controllers/chatBlock.controller.js'
import {
  listChatQuickContactsController,
  touchChatPresenceController,
} from '../controllers/chatQuickContacts.controller.js'
import { searchChatUsersController } from '../controllers/chatUserSearch.controller.js'
import { createRateLimit } from '../middleware/rateLimit.middleware.js'
import { requireUser } from '../middleware/user.middleware.js'
import { createSpamGuard } from '../middleware/spamGuard.middleware.js'

const router = express.Router()

const chatReadGuard = createRateLimit({
  key: 'chat-read',
  windowMs: 60 * 1000,
  max: 180,
  identity: (req) => req.user?.user_id,
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

const chatPresenceRateLimit =
  createRateLimit({
    key: 'chat-presence',
    windowMs: 60 * 1000,
    max: 30,
    message:
      'Too many presence updates. Please wait before trying again.',
    identity: (req) =>
      req.user?.user_id,
  })

router.use(requireUser)
router.use(chatConversationManagementRoutes)
router.use(chatMessageActionsRoutes)

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

router.post(
  '/groups',
  chatWriteGuard,
  createGroupConversationController
)

router.get(
  '/users/search',
  chatReadGuard,
  searchChatUsersController
)

router.get(
  '/quick-contacts',
  chatReadGuard,
  listChatQuickContactsController
)

router.patch(
  '/presence',
  chatPresenceRateLimit,
  touchChatPresenceController
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

router.get(
  '/conversations/:conversationId/block',
  chatReadGuard,
  getConversationBlockStatusController
)

router.post(
  '/conversations/:conversationId/messages',
  chatWriteGuard,
  sendConversationMessageController
)

router.patch(
  '/conversations/:conversationId/block',
  chatWriteGuard,
  blockConversationController
)

router.delete(
  '/conversations/:conversationId/block',
  chatWriteGuard,
  unblockConversationController
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
