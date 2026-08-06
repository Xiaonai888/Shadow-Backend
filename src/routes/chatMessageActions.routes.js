import express from 'express'
import {
  deleteMessagesController,
  editMessageController,
  forwardMessagesController,
  listPinnedMessagesController,
  pinMessageController,
  replyToMessageController,
  unpinMessageController,
} from '../controllers/chatMessageActions.controller.js'
import {
  reportChatMessageController,
} from '../controllers/chatMessageReport.controller.js'
import {
  createSpamGuard,
} from '../middleware/spamGuard.middleware.js'

const router = express.Router()

const messageReadGuard = createSpamGuard({
  scope: 'chat_message_action_read',
  threshold: 120,
  windowSeconds: 60,
})

const messageWriteGuard = createSpamGuard({
  scope: 'chat_message_action_write',
  threshold: 60,
  windowSeconds: 60,
})

const messageBulkGuard = createSpamGuard({
  scope: 'chat_message_action_bulk',
  threshold: 20,
  windowSeconds: 60,
})

const messageReportGuard = createSpamGuard({
  scope: 'chat_message_report',
  threshold: 10,
  windowSeconds: 60,
})

router.get(
  '/conversations/:conversationId/pins',
  messageReadGuard,
  listPinnedMessagesController
)

router.post(
  '/conversations/:conversationId/messages/:messageId/reply',
  messageWriteGuard,
  replyToMessageController
)

router.patch(
  '/conversations/:conversationId/messages/:messageId',
  messageWriteGuard,
  editMessageController
)

router.delete(
  '/conversations/:conversationId/messages/:messageId',
  messageWriteGuard,
  deleteMessagesController
)

router.delete(
  '/conversations/:conversationId/messages',
  messageBulkGuard,
  deleteMessagesController
)

router.post(
  '/conversations/:conversationId/messages/:messageId/pin',
  messageWriteGuard,
  pinMessageController
)

router.delete(
  '/conversations/:conversationId/messages/:messageId/pin',
  messageWriteGuard,
  unpinMessageController
)

router.post(
  '/conversations/:conversationId/messages/:messageId/report',
  messageReportGuard,
  reportChatMessageController
)

router.post(
  '/conversations/:conversationId/forward',
  messageBulkGuard,
  forwardMessagesController
)

export default router
