import { supabase } from '../config/supabase.js'
import {
  ChatServiceError,
  listMyConversations,
} from './chat.service.js'

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function fail(status, code, message) {
  throw new ChatServiceError(status, code, message)
}

function requireUuid(value, fieldName) {
  const id = String(value || '').trim()

  if (!UUID_PATTERN.test(id)) {
    fail(400, 'INVALID_ID', `${fieldName} is not valid`)
  }

  return id
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

async function getParticipant(conversationId, userId) {
  const safeConversationId = requireUuid(
    conversationId,
    'Conversation ID'
  )
  const safeUserId = requireUuid(userId, 'User ID')

  const { data, error } = await supabase
    .from('chat_participants')
    .select(
      'id, conversation_id, user_id, archived_at, deleted_at'
    )
    .eq('conversation_id', safeConversationId)
    .eq('user_id', safeUserId)
    .is('deleted_at', null)
    .maybeSingle()

  if (error) {
    throw databaseFailure(
      error,
      'Failed to load conversation'
    )
  }

  if (!data) {
    fail(
      404,
      'CONVERSATION_NOT_FOUND',
      'Conversation not found'
    )
  }

  return data
}

export async function listManagedConversations({
  userId,
  status,
  view,
}) {
  const safeUserId = requireUuid(userId, 'User ID')
  const normalizedView = String(view || 'active')
    .trim()
    .toLowerCase()

  if (!['active', 'archived'].includes(normalizedView)) {
    fail(
      400,
      'INVALID_CHAT_VIEW',
      'Chat view is not valid'
    )
  }

  let participantQuery = supabase
    .from('chat_participants')
    .select('conversation_id')
    .eq('user_id', safeUserId)
    .is('deleted_at', null)

  participantQuery =
    normalizedView === 'archived'
      ? participantQuery.not('archived_at', 'is', null)
      : participantQuery.is('archived_at', null)

  const { data, error } = await participantQuery.limit(100)

  if (error) {
    throw databaseFailure(
      error,
      'Failed to load conversations'
    )
  }

  if (!data?.length) {
    return []
  }

  const allowedIds = new Set(
    data.map((item) => String(item.conversation_id))
  )
  const conversations = await listMyConversations({
    userId: safeUserId,
    status,
  })

  return conversations.filter((conversation) =>
    allowedIds.has(String(conversation.id))
  )
}

export async function archiveConversation({
  userId,
  conversationId,
}) {
  const participant = await getParticipant(
    conversationId,
    userId
  )
  const archivedAt = new Date().toISOString()

  const { error } = await supabase
    .from('chat_participants')
    .update({ archived_at: archivedAt })
    .eq('id', participant.id)

  if (error) {
    throw databaseFailure(
      error,
      'Failed to archive conversation'
    )
  }

  return {
    conversation_id: participant.conversation_id,
    archived_at: archivedAt,
  }
}

export async function unarchiveConversation({
  userId,
  conversationId,
}) {
  const participant = await getParticipant(
    conversationId,
    userId
  )

  const { error } = await supabase
    .from('chat_participants')
    .update({ archived_at: null })
    .eq('id', participant.id)

  if (error) {
    throw databaseFailure(
      error,
      'Failed to restore conversation'
    )
  }

  return {
    conversation_id: participant.conversation_id,
    archived_at: null,
  }
}

export async function deleteConversationForUser({
  userId,
  conversationId,
}) {
  const participant = await getParticipant(
    conversationId,
    userId
  )
  const deletedAt = new Date().toISOString()

  const { error } = await supabase
    .from('chat_participants')
    .update({
      archived_at: null,
      deleted_at: deletedAt,
      last_read_at: deletedAt,
    })
    .eq('id', participant.id)

  if (error) {
    throw databaseFailure(
      error,
      'Failed to delete conversation'
    )
  }

  return {
    conversation_id: participant.conversation_id,
    deleted_at: deletedAt,
  }
}
