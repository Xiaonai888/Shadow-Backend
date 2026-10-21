import chatConversationManagementRoutes from './chatConversationManagement.routes.js'
import chatMessageActionsRoutes from './chatMessageActions.routes.js'
import chatArchivedPageRoutes from './chatArchivedPage.routes.js'
import express from 'express'
import { supabase } from '../config/supabase.js'
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
router.use(chatArchivedPageRoutes)
router.use(chatConversationManagementRoutes)
router.use(chatMessageActionsRoutes)

const inboxSummaryLimit = createRateLimit({
  key: 'chat-inbox-lightweight',
  windowMs: 60000,
  max: 30,
  identity: (req) => req.user?.user_id,
})


router.get('/conversations/unread-sender-count', inboxSummaryLimit, async (req, res) => {
  const role = String(req.query?.role || 'reader').trim().toLowerCase()

  if (!['reader', 'author'].includes(role)) {
    return res.status(400).json({ ok: false, message: 'Invalid chat role' })
  }

  try {
    const { data, error } = await supabase.rpc('get_chat_unread_sender_count_v1', {
      p_user_id: req.user?.user_id,
      p_role: role,
    })

    if (error) throw error
    const count = Number(data)
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new Error('Invalid unread sender count')
    }

    return res.status(200).json({ ok: true, unread_sender_count: count })
  } catch (error) {
    console.error('CHAT_UNREAD_SENDER_COUNT_ERROR', error?.message || error)
    return res.status(503).json({
      ok: false,
      code: 'CHAT_UNREAD_SENDER_COUNT_UNAVAILABLE',
      message: 'Unread sender count is temporarily unavailable',
    })
  }
})

router.get('/conversations/lightweight-page', inboxSummaryLimit, async (req, res) => {
  const role = String(req.query?.role || 'reader').trim().toLowerCase()
  const status = String(req.query?.status || 'all').trim().toLowerCase()
  const page = Number(req.query?.page || 1)
  if (!['reader', 'author'].includes(role) ||
      !['all', 'pending', 'accepted', 'declined', 'blocked'].includes(status) ||
      !Number.isInteger(page) || page < 1 || page > 1000) {
    return res.status(400).json({ ok: false, message: 'Invalid inbox query' })
  }
  try {
    const { data, error } = await supabase.rpc('get_chat_inbox_lightweight_v1', {
      p_user_id: req.user?.user_id,
      p_role: role,
      p_page: page,
      p_limit: 10,
      p_status: status,
    })
    if (error) throw error
    if (!data || !Array.isArray(data.conversations)) {
      throw new Error('Invalid inbox response')
    }
    return res.status(200).json({ ok: true, ...data })
  } catch (error) {
    console.error('CHAT_INBOX_LIGHTWEIGHT_ERROR', error?.message || error)
    return res.status(503).json({
      ok: false,
      code: 'CHAT_INBOX_UNAVAILABLE',
      message: 'Chat inbox is temporarily unavailable',
    })
  }
})

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
