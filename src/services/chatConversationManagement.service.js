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

function normalizeDeleteScope(scope) {
  const normalized = String(scope || 'for_me')
    .trim()
    .toLowerCase()

  if (
    ['for_me', 'me', 'user', 'myself'].includes(normalized)
  ) {
    return 'for_me'
  }

  if (
    ['for_both', 'both', 'all', 'everyone'].includes(normalized)
  ) {
    return 'for_both'
  }

  fail(
    400,
    'INVALID_DELETE_SCOPE',
    'Delete option is not valid'
  )
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
      'id, conversation_id, user_id, archived_at, deleted_at, cleared_at, last_read_at'
    )
    .eq('conversation_id', safeConversationId)
    .eq('user_id', safeUserId)
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

async function getConversationState(conversationId) {
  const safeConversationId = requireUuid(
    conversationId,
    'Conversation ID'
  )

  const { data, error } = await supabase
    .from('chat_conversations')
    .select('id, cleared_for_all_at')
    .eq('id', safeConversationId)
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

async function getParticipantStates(conversationId) {
  const { data, error } = await supabase
    .from('chat_participants')
    .select(
      'id, archived_at, deleted_at, cleared_at, last_read_at'
    )
    .eq('conversation_id', conversationId)

  if (error) {
    throw databaseFailure(
      error,
      'Failed to load conversation participants'
    )
  }

  if (!data?.length) {
    fail(
      409,
      'PARTICIPANT_MISSING',
      'Conversation participants are unavailable'
    )
  }

  return data
}

async function rollbackDeleteForBoth({
  conversation,
  participants,
}) {
  const operations = [
    supabase
      .from('chat_conversations')
      .update({
        cleared_for_all_at:
          conversation.cleared_for_all_at || null,
      })
      .eq('id', conversation.id),
    ...participants.map((participant) =>
      supabase
        .from('chat_participants')
        .update({
          archived_at:
            participant.archived_at || null,
          deleted_at:
            participant.deleted_at || null,
          cleared_at:
            participant.cleared_at || null,
          last_read_at:
            participant.last_read_at || null,
        })
        .eq('id', participant.id)
    ),
  ]

  await Promise.allSettled(operations)
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
      cleared_at: deletedAt,
      last_read_at: deletedAt,
    })
    .eq('id', participant.id)

  if (error) {
    throw databaseFailure(
      error,
      'Failed to delete conversation for you'
    )
  }

  return {
    conversation_id: participant.conversation_id,
    delete_scope: 'for_me',
    cleared_at: deletedAt,
    deleted_at: deletedAt,
  }
}

export async function deleteConversationForBoth({
  userId,
  conversationId,
}) {
  const participant = await getParticipant(
    conversationId,
    userId
  )
  const [conversation, participants] = await Promise.all([
    getConversationState(participant.conversation_id),
    getParticipantStates(participant.conversation_id),
  ])
  const deletedAt = new Date().toISOString()

  const { error: conversationError } = await supabase
    .from('chat_conversations')
    .update({
      cleared_for_all_at: deletedAt,
    })
    .eq('id', conversation.id)

  if (conversationError) {
    throw databaseFailure(
      conversationError,
      'Failed to delete conversation for both'
    )
  }

  const { error: participantsError } = await supabase
    .from('chat_participants')
    .update({
      archived_at: null,
      deleted_at: deletedAt,
      cleared_at: deletedAt,
      last_read_at: deletedAt,
    })
    .eq('conversation_id', conversation.id)

  if (participantsError) {
    await rollbackDeleteForBoth({
      conversation,
      participants,
    })

    throw databaseFailure(
      participantsError,
      'Failed to delete conversation for both'
    )
  }

  const { error: pinsError } = await supabase
    .from('chat_message_pins')
    .delete()
    .eq('conversation_id', conversation.id)

  if (pinsError) {
    await rollbackDeleteForBoth({
      conversation,
      participants,
    })

    throw databaseFailure(
      pinsError,
      'Failed to remove pinned messages'
    )
  }

  return {
    conversation_id: conversation.id,
    delete_scope: 'for_both',
    cleared_for_all_at: deletedAt,
    deleted_at: deletedAt,
    affected_participants: participants.length,
  }
}

export async function deleteConversation({
  userId,
  conversationId,
  scope,
}) {
  const normalizedScope = normalizeDeleteScope(scope)

  if (normalizedScope === 'for_both') {
    return deleteConversationForBoth({
      userId,
      conversationId,
    })
  }

  return deleteConversationForUser({
    userId,
    conversationId,
  })
}
