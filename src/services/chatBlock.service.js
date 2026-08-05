import { supabase } from '../config/supabase.js'

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export class ChatBlockError extends Error {
  constructor(status, code, message) {
    super(message)
    this.name = 'ChatBlockError'
    this.status = status
    this.code = code
  }
}

function fail(status, code, message) {
  throw new ChatBlockError(
    status,
    code,
    message
  )
}

function requireUuid(value, fieldName) {
  const id = String(value || '').trim()

  if (!UUID_PATTERN.test(id)) {
    fail(
      400,
      'INVALID_ID',
      `${fieldName} is not valid`
    )
  }

  return id
}

function databaseFailure(error, message) {
  const wrapped = new ChatBlockError(
    500,
    'CHAT_BLOCK_DATABASE_ERROR',
    message
  )

  wrapped.cause = error
  return wrapped
}

export async function blockConversation({
  userId,
  conversationId,
}) {
  const safeUserId = requireUuid(
    userId,
    'User ID'
  )
  const safeConversationId = requireUuid(
    conversationId,
    'Conversation ID'
  )

  const {
    data: participant,
    error: participantError,
  } = await supabase
    .from('chat_participants')
    .select('id, user_id')
    .eq(
      'conversation_id',
      safeConversationId
    )
    .eq('user_id', safeUserId)
    .is('deleted_at', null)
    .maybeSingle()

  if (participantError) {
    throw databaseFailure(
      participantError,
      'Failed to verify chat access'
    )
  }

  if (!participant) {
    fail(
      403,
      'CHAT_ACCESS_DENIED',
      'You cannot manage this conversation'
    )
  }

  const {
    data: otherParticipant,
    error: otherParticipantError,
  } = await supabase
    .from('chat_participants')
    .select('user_id')
    .eq(
      'conversation_id',
      safeConversationId
    )
    .neq('user_id', safeUserId)
    .is('deleted_at', null)
    .limit(1)
    .maybeSingle()

  if (otherParticipantError) {
    throw databaseFailure(
      otherParticipantError,
      'Failed to load chat participant'
    )
  }

  if (!otherParticipant?.user_id) {
    fail(
      409,
      'PARTICIPANT_MISSING',
      'The other participant is unavailable'
    )
  }

  const { error: blockError } =
    await supabase
      .from('chat_blocks')
      .insert({
        blocker_user_id: safeUserId,
        blocked_user_id:
          otherParticipant.user_id,
      })

  if (
    blockError &&
    blockError.code !== '23505'
  ) {
    throw databaseFailure(
      blockError,
      'Failed to block account'
    )
  }

  const {
    data: conversation,
    error: conversationError,
  } = await supabase
    .from('chat_conversations')
    .update({
      request_status: 'blocked',
      request_decided_at:
        new Date().toISOString(),
    })
    .eq('id', safeConversationId)
    .select('id, request_status')
    .single()

  if (conversationError) {
    throw databaseFailure(
      conversationError,
      'Failed to block conversation'
    )
  }

  return conversation
}
