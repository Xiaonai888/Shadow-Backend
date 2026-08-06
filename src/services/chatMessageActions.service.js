import { supabase } from '../config/supabase.js'
import {
  ChatServiceError,
} from './chat.service.js'

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const MAX_SELECTED_MESSAGES = 100

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

function cleanText(value, maxLength = 2000) {
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

function requireMessage(value) {
  const body = cleanText(value, 2000)

  if (!body) {
    fail(
      400,
      'MESSAGE_REQUIRED',
      'Message is required'
    )
  }

  return body
}

function requireMessageIds(value) {
  if (!Array.isArray(value)) {
    fail(
      400,
      'MESSAGE_IDS_REQUIRED',
      'Select at least one message'
    )
  }

  const uniqueIds = [
    ...new Set(
      value.map((item) =>
        requireUuid(item, 'Message ID')
      )
    ),
  ]

  if (!uniqueIds.length) {
    fail(
      400,
      'MESSAGE_IDS_REQUIRED',
      'Select at least one message'
    )
  }

  if (
    uniqueIds.length >
    MAX_SELECTED_MESSAGES
  ) {
    fail(
      400,
      'MESSAGE_SELECTION_LIMIT',
      `You can select up to ${MAX_SELECTED_MESSAGES} messages`
    )
  }

  return uniqueIds
}

async function getConversationAccess({
  conversationId,
  userId,
}) {
  const safeConversationId = requireUuid(
    conversationId,
    'Conversation ID'
  )
  const safeUserId = requireUuid(
    userId,
    'User ID'
  )

  const [
    conversationResult,
    participantResult,
  ] = await Promise.all([
    supabase
      .from('chat_conversations')
      .select(
        'id, request_status, cleared_for_all_at'
      )
      .eq('id', safeConversationId)
      .maybeSingle(),
    supabase
      .from('chat_participants')
      .select(
        'id, conversation_id, user_id, participant_role, archived_at, deleted_at, cleared_at'
      )
      .eq(
        'conversation_id',
        safeConversationId
      )
      .eq('user_id', safeUserId)
      .is('deleted_at', null)
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

  return {
    conversation: conversationResult.data,
    participant: participantResult.data,
    userId: safeUserId,
  }
}

function requireAcceptedConversation(
  conversation
) {
  if (
    conversation.request_status !==
    'accepted'
  ) {
    fail(
      409,
      'CHAT_NOT_AVAILABLE',
      'This conversation cannot receive messages'
    )
  }
}

async function getMessages({
  conversationId,
  messageIds,
  includeDeleted = false,
}) {
  let query = supabase
    .from('chat_messages')
    .select(
      'id, conversation_id, sender_user_id, message_type, body, is_request_message, reply_to_message_id, forwarded_from_message_id, forwarded_from_user_id, edited_at, deleted_at, created_at'
    )
    .eq(
      'conversation_id',
      conversationId
    )
    .in('id', messageIds)

  if (!includeDeleted) {
    query = query.is('deleted_at', null)
  }

  const { data, error } = await query

  if (error) {
    throw databaseFailure(
      error,
      'Failed to load messages'
    )
  }

  const messages = data || []

  if (
    messages.length !== messageIds.length
  ) {
    fail(
      404,
      'MESSAGE_NOT_FOUND',
      'One or more messages were not found'
    )
  }

  const messageMap = new Map(
    messages.map((message) => [
      String(message.id),
      message,
    ])
  )

  return messageIds.map((id) =>
    messageMap.get(String(id))
  )
}

async function getMessage({
  conversationId,
  messageId,
  includeDeleted = false,
}) {
  const messages = await getMessages({
    conversationId,
    messageIds: [
      requireUuid(
        messageId,
        'Message ID'
      ),
    ],
    includeDeleted,
  })

  return messages[0]
}

async function restoreParticipants({
  conversationId,
  senderParticipantId,
}) {
  const now = new Date().toISOString()

  const [
    restoreResult,
    senderResult,
  ] = await Promise.all([
    supabase
      .from('chat_participants')
      .update({
        archived_at: null,
        deleted_at: null,
      })
      .eq(
        'conversation_id',
        conversationId
      ),
    supabase
      .from('chat_participants')
      .update({
        archived_at: null,
        deleted_at: null,
        last_read_at: now,
      })
      .eq('id', senderParticipantId),
  ])

  if (
    restoreResult.error ||
    senderResult.error
  ) {
    throw databaseFailure(
      restoreResult.error ||
        senderResult.error,
      'Failed to restore conversation'
    )
  }
}

export async function replyToMessage({
  userId,
  conversationId,
  replyToMessageId,
  message,
}) {
  const {
    conversation,
    participant,
    userId: safeUserId,
  } = await getConversationAccess({
    conversationId,
    userId,
  })

  requireAcceptedConversation(
    conversation
  )

  const originalMessage =
    await getMessage({
      conversationId:
        conversation.id,
      messageId: replyToMessageId,
    })

  const body = requireMessage(message)

  const { data, error } = await supabase
    .from('chat_messages')
    .insert({
      conversation_id:
        conversation.id,
      sender_user_id: safeUserId,
      message_type: 'text',
      body,
      is_request_message: false,
      reply_to_message_id:
        originalMessage.id,
    })
    .select(
      'id, conversation_id, sender_user_id, message_type, body, is_request_message, reply_to_message_id, forwarded_from_message_id, forwarded_from_user_id, edited_at, deleted_at, created_at'
    )
    .single()

  if (error) {
    throw databaseFailure(
      error,
      'Failed to send reply'
    )
  }

  await restoreParticipants({
    conversationId:
      conversation.id,
    senderParticipantId:
      participant.id,
  })

  return data
}

export async function editMessage({
  userId,
  conversationId,
  messageId,
  message,
}) {
  const {
    conversation,
    userId: safeUserId,
  } = await getConversationAccess({
    conversationId,
    userId,
  })

  const currentMessage =
    await getMessage({
      conversationId:
        conversation.id,
      messageId,
    })

  if (
    String(
      currentMessage.sender_user_id
    ) !== safeUserId
  ) {
    fail(
      403,
      'MESSAGE_OWNER_REQUIRED',
      'You can only edit your own message'
    )
  }

  if (
    currentMessage.message_type !==
    'text'
  ) {
    fail(
      400,
      'MESSAGE_NOT_EDITABLE',
      'This message cannot be edited'
    )
  }

  const body = requireMessage(message)
  const editedAt =
    new Date().toISOString()

  const { data, error } = await supabase
    .from('chat_messages')
    .update({
      body,
      edited_at: editedAt,
    })
    .eq('id', currentMessage.id)
    .eq(
      'conversation_id',
      conversation.id
    )
    .eq(
      'sender_user_id',
      safeUserId
    )
    .is('deleted_at', null)
    .select(
      'id, conversation_id, sender_user_id, message_type, body, is_request_message, reply_to_message_id, forwarded_from_message_id, forwarded_from_user_id, edited_at, deleted_at, created_at'
    )
    .single()

  if (error) {
    throw databaseFailure(
      error,
      'Failed to edit message'
    )
  }

  return data
}

export async function deleteMessages({
  userId,
  conversationId,
  messageIds,
}) {
  const {
    conversation,
    userId: safeUserId,
  } = await getConversationAccess({
    conversationId,
    userId,
  })

  const safeMessageIds =
    requireMessageIds(messageIds)
  const messages = await getMessages({
    conversationId:
      conversation.id,
    messageIds: safeMessageIds,
  })

  const hasOtherOwner =
    messages.some(
      (message) =>
        String(
          message.sender_user_id
        ) !== safeUserId
    )

  if (hasOtherOwner) {
    fail(
      403,
      'MESSAGE_OWNER_REQUIRED',
      'You can only delete your own messages'
    )
  }

  const deletedAt =
    new Date().toISOString()

  const { data, error } = await supabase
    .from('chat_messages')
    .update({
      deleted_at: deletedAt,
    })
    .eq(
      'conversation_id',
      conversation.id
    )
    .eq(
      'sender_user_id',
      safeUserId
    )
    .in('id', safeMessageIds)
    .is('deleted_at', null)
    .select('id')

  if (error) {
    throw databaseFailure(
      error,
      'Failed to delete messages'
    )
  }

  const deletedIds = (data || []).map(
    (item) => item.id
  )

  if (deletedIds.length) {
    const { error: pinError } =
      await supabase
        .from('chat_message_pins')
        .delete()
        .eq(
          'conversation_id',
          conversation.id
        )
        .in(
          'message_id',
          deletedIds
        )

    if (pinError) {
      throw databaseFailure(
        pinError,
        'Failed to remove deleted message pins'
      )
    }
  }

  return {
    conversation_id:
      conversation.id,
    deleted_message_ids:
      deletedIds,
    deleted_at: deletedAt,
  }
}

export async function pinMessage({
  userId,
  conversationId,
  messageId,
}) {
  const {
    conversation,
    userId: safeUserId,
  } = await getConversationAccess({
    conversationId,
    userId,
  })

  const message = await getMessage({
    conversationId:
      conversation.id,
    messageId,
  })

  const { data, error } = await supabase
    .from('chat_message_pins')
    .upsert(
      {
        conversation_id:
          conversation.id,
        message_id: message.id,
        pinned_by_user_id:
          safeUserId,
      },
      {
        onConflict:
          'conversation_id,message_id',
      }
    )
    .select(
      'id, conversation_id, message_id, pinned_by_user_id, created_at'
    )
    .single()

  if (error) {
    throw databaseFailure(
      error,
      'Failed to pin message'
    )
  }

  return {
    ...data,
    message,
  }
}

export async function unpinMessage({
  userId,
  conversationId,
  messageId,
}) {
  const {
    conversation,
  } = await getConversationAccess({
    conversationId,
    userId,
  })
  const safeMessageId = requireUuid(
    messageId,
    'Message ID'
  )

  const { error } = await supabase
    .from('chat_message_pins')
    .delete()
    .eq(
      'conversation_id',
      conversation.id
    )
    .eq(
      'message_id',
      safeMessageId
    )

  if (error) {
    throw databaseFailure(
      error,
      'Failed to unpin message'
    )
  }

  return {
    conversation_id:
      conversation.id,
    message_id: safeMessageId,
    is_pinned: false,
  }
}

export async function listPinnedMessages({
  userId,
  conversationId,
}) {
  const {
    conversation,
  } = await getConversationAccess({
    conversationId,
    userId,
  })

  const { data: pins, error } =
    await supabase
      .from('chat_message_pins')
      .select(
        'id, conversation_id, message_id, pinned_by_user_id, created_at'
      )
      .eq(
        'conversation_id',
        conversation.id
      )
      .order(
        'created_at',
        {
          ascending: false,
        }
      )
      .limit(100)

  if (error) {
    throw databaseFailure(
      error,
      'Failed to load pinned messages'
    )
  }

  if (!pins?.length) {
    return []
  }

  const messages = await getMessages({
    conversationId:
      conversation.id,
    messageIds: pins.map(
      (pin) => pin.message_id
    ),
  })
  const messageMap = new Map(
    messages.map((message) => [
      String(message.id),
      message,
    ])
  )

  return pins
    .map((pin) => ({
      ...pin,
      message: messageMap.get(
        String(pin.message_id)
      ),
    }))
    .filter((pin) =>
      Boolean(pin.message)
    )
}

export async function forwardMessages({
  userId,
  sourceConversationId,
  targetConversationId,
  messageIds,
}) {
  const [
    sourceAccess,
    targetAccess,
  ] = await Promise.all([
    getConversationAccess({
      conversationId:
        sourceConversationId,
      userId,
    }),
    getConversationAccess({
      conversationId:
        targetConversationId,
      userId,
    }),
  ])

  requireAcceptedConversation(
    targetAccess.conversation
  )

  const safeMessageIds =
    requireMessageIds(messageIds)
  const sourceMessages =
    await getMessages({
      conversationId:
        sourceAccess.conversation.id,
      messageIds:
        safeMessageIds,
    })

  const unsupportedMessage =
    sourceMessages.find(
      (message) =>
        message.message_type !==
          'text' ||
        !cleanText(message.body)
    )

  if (unsupportedMessage) {
    fail(
      400,
      'MESSAGE_NOT_FORWARDABLE',
      'One or more messages cannot be forwarded'
    )
  }

  const rows = sourceMessages.map(
    (message) => ({
      conversation_id:
        targetAccess.conversation.id,
      sender_user_id:
        targetAccess.userId,
      message_type: 'text',
      body: cleanText(
        message.body
      ),
      is_request_message: false,
      forwarded_from_message_id:
        message.id,
      forwarded_from_user_id:
        message.sender_user_id,
    })
  )

  const { data, error } = await supabase
    .from('chat_messages')
    .insert(rows)
    .select(
      'id, conversation_id, sender_user_id, message_type, body, is_request_message, reply_to_message_id, forwarded_from_message_id, forwarded_from_user_id, edited_at, deleted_at, created_at'
    )

  if (error) {
    throw databaseFailure(
      error,
      'Failed to forward messages'
    )
  }

  await restoreParticipants({
    conversationId:
      targetAccess.conversation.id,
    senderParticipantId:
      targetAccess.participant.id,
  })

  return {
    source_conversation_id:
      sourceAccess.conversation.id,
    target_conversation_id:
      targetAccess.conversation.id,
    forwarded_messages:
      data || [],
  }
}

export {
  MAX_SELECTED_MESSAGES,
}
