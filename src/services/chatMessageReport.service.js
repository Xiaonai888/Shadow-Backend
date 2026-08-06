import { supabase } from '../config/supabase.js'
import {
  ChatServiceError,
} from './chat.service.js'

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const REPORT_REASONS = new Set([
  'spam',
  'harassment',
  'hate',
  'sexual_content',
  'violence',
  'scam',
  'impersonation',
  'privacy',
  'other',
])

function fail(status, code, message) {
  throw new ChatServiceError(
    status,
    code,
    message
  )
}

function databaseFailure(error, message) {
  const wrapped = new ChatServiceError(
    500,
    'CHAT_DATABASE_ERROR',
    message
  )

  wrapped.cause = error
  return wrapped
}

function cleanText(value, maxLength) {
  return String(value || '')
    .trim()
    .slice(0, maxLength)
}

function requireUuid(value, fieldName) {
  const id = cleanText(value, 100)

  if (!UUID_PATTERN.test(id)) {
    fail(
      400,
      'INVALID_ID',
      `${fieldName} is not valid`
    )
  }

  return id
}

function requireReason(value) {
  const reason = cleanText(
    value,
    40
  ).toLowerCase()

  if (!REPORT_REASONS.has(reason)) {
    fail(
      400,
      'INVALID_REPORT_REASON',
      'Report reason is not valid'
    )
  }

  return reason
}

function getVisibilityCutoff(
  conversation,
  participant
) {
  const timestamps = [
    conversation?.cleared_for_all_at,
    participant?.cleared_at,
  ]
    .filter(Boolean)
    .map((value) =>
      new Date(value).getTime()
    )
    .filter(Number.isFinite)

  return timestamps.length
    ? Math.max(...timestamps)
    : null
}

export async function reportChatMessage({
  userId,
  conversationId,
  messageId,
  reason,
  details,
}) {
  const safeUserId = requireUuid(
    userId,
    'User ID'
  )
  const safeConversationId = requireUuid(
    conversationId,
    'Conversation ID'
  )
  const safeMessageId = requireUuid(
    messageId,
    'Message ID'
  )
  const safeReason = requireReason(reason)
  const safeDetails =
    cleanText(details, 1000) || null

  const [
    conversationResult,
    participantResult,
    messageResult,
  ] = await Promise.all([
    supabase
      .from('chat_conversations')
      .select(
        'id, cleared_for_all_at'
      )
      .eq('id', safeConversationId)
      .maybeSingle(),
    supabase
      .from('chat_participants')
      .select(
        'id, user_id, cleared_at, deleted_at'
      )
      .eq(
        'conversation_id',
        safeConversationId
      )
      .eq('user_id', safeUserId)
      .is('deleted_at', null)
      .maybeSingle(),
    supabase
      .from('chat_messages')
      .select(
        'id, conversation_id, sender_user_id, body, deleted_at, created_at'
      )
      .eq('id', safeMessageId)
      .eq(
        'conversation_id',
        safeConversationId
      )
      .maybeSingle(),
  ])

  if (conversationResult.error) {
    throw databaseFailure(
      conversationResult.error,
      'Failed to load conversation'
    )
  }

  if (participantResult.error) {
    throw databaseFailure(
      participantResult.error,
      'Failed to verify chat access'
    )
  }

  if (messageResult.error) {
    throw databaseFailure(
      messageResult.error,
      'Failed to load message'
    )
  }

  if (!conversationResult.data) {
    fail(
      404,
      'CONVERSATION_NOT_FOUND',
      'Conversation not found'
    )
  }

  if (!participantResult.data) {
    fail(
      403,
      'CHAT_ACCESS_DENIED',
      'You cannot access this conversation'
    )
  }

  const message = messageResult.data

  if (!message || message.deleted_at) {
    fail(
      404,
      'MESSAGE_NOT_FOUND',
      'Message not found'
    )
  }

  if (
    String(message.sender_user_id) ===
    safeUserId
  ) {
    fail(
      400,
      'CANNOT_REPORT_OWN_MESSAGE',
      'You cannot report your own message'
    )
  }

  const visibilityCutoff =
    getVisibilityCutoff(
      conversationResult.data,
      participantResult.data
    )
  const messageTime = new Date(
    message.created_at
  ).getTime()

  if (
    visibilityCutoff &&
    (
      !Number.isFinite(messageTime) ||
      messageTime <= visibilityCutoff
    )
  ) {
    fail(
      404,
      'MESSAGE_NOT_FOUND',
      'Message not found'
    )
  }

  const { data, error } = await supabase
    .from('chat_message_reports')
    .insert({
      conversation_id:
        safeConversationId,
      message_id: safeMessageId,
      reporter_user_id:
        safeUserId,
      reported_user_id:
        message.sender_user_id,
      reason: safeReason,
      details: safeDetails,
    })
    .select(
      'id, conversation_id, message_id, reporter_user_id, reported_user_id, reason, details, status, created_at'
    )
    .single()

  if (error) {
    if (error.code === '23505') {
      fail(
        409,
        'REPORT_ALREADY_SUBMITTED',
        'You already reported this message'
      )
    }

    throw databaseFailure(
      error,
      'Failed to submit report'
    )
  }

  const {
    error: holdError,
  } = await supabase.rpc(
    'set_chat_legal_hold',
    {
      p_conversation_id:
        safeConversationId,
      p_admin_id:
        'system:message-report',
      p_reason:
        `Open message report ${data.id}`,
    }
  )

  if (holdError) {
    await supabase
      .from('chat_message_reports')
      .delete()
      .eq('id', data.id)

    throw databaseFailure(
      holdError,
      'Failed to preserve report evidence'
    )
  }

  return {
    ...data,
    evidence_preserved: true,
  }
}

export {
  REPORT_REASONS,
}
