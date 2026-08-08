import chatConversationManagementRoutes from './chatConversationManagement.routes.js'
import chatMessageActionsRoutes from './chatMessageActions.routes.js'
import express from 'express'
import multer from 'multer'
import {
  createReaderAuthorRequestController,
  createReaderReaderRequestController,
  decideMessageRequestController,
  getConversationMessagesController,
  listMyConversationsController,
  markConversationReadController,
  sendConversationAttachmentController,
  sendConversationMessageController,
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
import { requireUser } from '../middleware/user.middleware.js'
import { createSpamGuard } from '../middleware/spamGuard.middleware.js'

const router = express.Router()
const CHAT_ATTACHMENTS_ENABLED = false

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

const chatAttachmentUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 8 * 1024 * 1024,
    files: 1,
  },
}).single('file')

function uploadChatAttachment(req, res, next) {
  chatAttachmentUpload(req, res, (error) => {
    if (!error) {
      next()
      return
    }

    const tooLarge =
      error.code === 'LIMIT_FILE_SIZE'

    res.status(tooLarge ? 413 : 400).json({
      ok: false,
      code: tooLarge
        ? 'CHAT_ATTACHMENT_TOO_LARGE'
        : 'CHAT_ATTACHMENT_UPLOAD_INVALID',
      message: tooLarge
        ? 'File must be 8 MB or smaller'
        : 'Unable to read this file',
    })
  })
}

const chatRequestGuard = createSpamGuard({
  scope: 'chat_request',
  threshold: 5,
  windowSeconds: 60,
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
  chatWriteGuard,
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

if (CHAT_ATTACHMENTS_ENABLED) {
  router.post(
    '/conversations/:conversationId/attachments',
    chatWriteGuard,
    uploadChatAttachment,
    sendConversationAttachmentController
  )
}

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
