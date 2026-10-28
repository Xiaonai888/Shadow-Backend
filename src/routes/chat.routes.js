import chatConversationManagementRoutes from './chatConversationManagement.routes.js'
import chatMessageActionsRoutes from './chatMessageActions.routes.js'
import chatArchivedPageRoutes from './chatArchivedPage.routes.js'
import authorStoreBookChatRoutes from './authorStoreBookChat.routes.js'
import authorStoreBookChatNoticesRoutes from './authorStoreBookChatNotices.routes.js'
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
import { markRequestDiagnostic } from '../services/trafficDiagnostic.service.js'

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

router.use(authorStoreBookChatNoticesRoutes)
router.use(authorStoreBookChatRoutes)
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

// Only diagnostics: leave the existing inbox rate limit and chat RPC behavior intact.
const INBOX_ERROR_LOG_INTERVAL_MS = 60 * 1000
const inboxErrorLogTimes = new Map()

function safeInboxErrorText(value, maxLength = 180) {
  return String(value ?? '')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '[uuid]')
    .replace(/\b[A-Za-z0-9_-]{48,}\b/g, '[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength)
}

function diagnoseInboxIssue(feature, stage, error = null, extra = {}) {
  const code = safeInboxErrorText(error?.code || 'UNKNOWN', 60)
  const diagnostic = {
    feature,
    stage,
    error_code: code,
    error_message: safeInboxErrorText(error?.message, 160),
    error_details: safeInboxErrorText(error?.details, 160),
    error_hint: safeInboxErrorText(error?.hint, 160),
    provider_status: Number(error?.status) || 0,
    ...extra,
  }
  markRequestDiagnostic(diagnostic)

  // Rate-limit repetitive server logs without hiding per-request diagnostics.
  const key = `${feature}:${stage}:${code}`
  const now = Date.now()
  if (now - (inboxErrorLogTimes.get(key) || 0) < INBOX_ERROR_LOG_INTERVAL_MS) return
  inboxErrorLogTimes.set(key, now)
  if (inboxErrorLogTimes.size > 20) {
    inboxErrorLogTimes.delete(inboxErrorLogTimes.keys().next().value)
  }
  console.error('CHAT_INBOX_DIAGNOSTIC', diagnostic)
}

function diagnosticInboxSummaryLimit(req, res, next) {
  const originalJson = res.json.bind(res)
  // Intercept the limiter's response only; restore res.json for the actual handler.
  res.json = (body) => {
    if (res.statusCode === 429) {
      diagnoseInboxIssue('chat_inbox_summary', 'rate_limited', {
        code: 'RATE_LIMIT_429',
        message: 'Inbox summary rate limit reached',
      }, {
        endpoint: req.path === '/conversations/unread-sender-count'
          ? 'unread_sender_count'
          : 'lightweight_page',
        response_status: 429,
        retry_after: String(res.getHeader('Retry-After') || '').slice(0, 10),
      })
    }
    return originalJson(body)
  }
  return inboxSummaryLimit(req, res, () => {
    res.json = originalJson
    next()
  })
}

router.get('/conversations/unread-sender-count', diagnosticInboxSummaryLimit, async (req, res) => {
  const role = String(req.query?.role || 'reader').trim().toLowerCase()

  if (!['reader', 'author'].includes(role)) {
    markRequestDiagnostic({
      feature: 'chat_unread_sender_count',
      stage: 'input_validation',
      error_code: 'INVALID_ROLE',
      response_status: 400,
    })
    return res.status(400).json({ ok: false, message: 'Invalid chat role' })
  }

  let stage = 'rpc_get_chat_unread_sender_count_v1'
  try {
    const { data, error } = await supabase.rpc('get_chat_unread_sender_count_v1', {
      p_user_id: req.user?.user_id,
      p_role: role,
    })

    if (error) throw error
    stage = 'response_validation'
    const count = Number(data)
    if (!Number.isSafeInteger(count) || count < 0) {
      const invalidCount = new Error('Invalid unread sender count')
      invalidCount.code = 'INVALID_COUNT_RESPONSE'
      throw invalidCount
    }

    return res.status(200).json({ ok: true, unread_sender_count: count })
  } catch (error) {
    diagnoseInboxIssue('chat_unread_sender_count', stage, error, {
      role,
      response_status: 503,
    })
    return res.status(503).json({
      ok: false,
      code: 'CHAT_UNREAD_SENDER_COUNT_UNAVAILABLE',
      message: 'Unread sender count is temporarily unavailable',
    })
  }
})

router.get('/conversations/lightweight-page', diagnosticInboxSummaryLimit, async (req, res) => {
  const role = String(req.query?.role || 'reader').trim().toLowerCase()
  const status = String(req.query?.status || 'all').trim().toLowerCase()
  const page = Number(req.query?.page || 1)
  if (!['reader', 'author'].includes(role) ||
      !['all', 'pending', 'accepted', 'declined', 'blocked'].includes(status) ||
      !Number.isInteger(page) || page < 1 || page > 1000) {
    markRequestDiagnostic({
      feature: 'chat_inbox_lightweight',
      stage: 'input_validation',
      error_code: 'INVALID_INBOX_QUERY',
      response_status: 400,
    })
    return res.status(400).json({ ok: false, message: 'Invalid inbox query' })
  }
  let stage = 'rpc_get_chat_inbox_lightweight_v1'
  try {
    const { data, error } = await supabase.rpc('get_chat_inbox_lightweight_v1', {
      p_user_id: req.user?.user_id,
      p_role: role,
      p_page: page,
      p_limit: 10,
      p_status: status,
    })
    if (error) throw error
    stage = 'response_validation'
    if (!data || !Array.isArray(data.conversations)) {
      const invalidInbox = new Error('Invalid inbox response')
      invalidInbox.code = 'INVALID_INBOX_RESPONSE'
      throw invalidInbox
    }
    return res.status(200).json({ ok: true, ...data })
  } catch (error) {
    diagnoseInboxIssue('chat_inbox_lightweight', stage, error, {
      role,
      inbox_status: status,
      response_status: 503,
    })
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
