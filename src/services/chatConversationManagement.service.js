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

function databaseFailure(error, message) {
  const wrapped = new ChatServiceError(
    500,
    'CHAT_DATABASE_ERROR',
    message
  )

  wrapped.cause = error
  return wrapped
}

function mapDeleteError(error) {
  const details = [
    error?.message,
    error?.details,
    error?.hint,
  ]
    .filter(Boolean)
    .join(' ')
    .toUpperCase()

  if (
    details.includes(
      'AUTHOR_PAGE_CHAT_DELETE_FOR_BOTH_NOT_ALLOWED'
    )
  ) {
    return new ChatServiceError(
      403,
      'AUTHOR_PAGE_DELETE_FOR_BOTH_NOT_ALLOWED',
      'Author Page conversations can only be deleted for your side'
    )
  }

  if (details.includes('CONVERSATION_NOT_FOUND')) {
    return new ChatServiceError(
      404,
      'CONVERSATION_NOT_FOUND',
      'Conversation not found'
    )
  }

  if (details.includes('INVALID_DELETE_SCOPE')) {
    return new ChatServiceError(
      400,
      'INVALID_DELETE_SCOPE',
      'Delete option is not valid'
    )
  }

  return databaseFailure(
    error,
    'Failed to delete conversation'
  )
}

async function getActiveParticipant(
  conversationId,
  userId
) {
  const safeConversationId = requireUuid(
    conversationId,
    'Conversation ID'
  )
  const safeUserId = requireUuid(userId, 'User ID')

  const { data, error } = await supabase
    .from('chat_participants')
    .select(
      'id, conversation_id, user_id, participant_role, archived_at, deleted_at, cleared_at, retention_until, last_read_at'
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

  return conversations
    .filter((conversation) =>
      allowedIds.has(String(conversation.id))
    )
    .map((conversation) => ({
      ...conversation,
      delete_permissions: {
        can_delete_for_me: true,
        can_delete_for_both:
          conversation.conversation_type ===
          'reader_reader',
        retention_days: 90,
      },
    }))
}

export async function archiveConversation({
  userId,
  conversationId,
}) {
  const participant = await getActiveParticipant(
    conversationId,
    userId
  )
  const archivedAt = new Date().toISOString()

  const { error } = await supabase
    .from('chat_participants')
    .update({ archived_at: archivedAt })
    .eq('id', participant.id)
    .is('deleted_at', null)

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
  const participant = await getActiveParticipant(
    conversationId,
    userId
  )

  const { error } = await supabase
    .from('chat_participants')
    .update({ archived_at: null })
    .eq('id', participant.id)
    .is('deleted_at', null)

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

export async function deleteConversation({
  userId,
  conversationId,
  scope,
}) {
  const safeUserId = requireUuid(userId, 'User ID')
  const safeConversationId = requireUuid(
    conversationId,
    'Conversation ID'
  )
  const normalizedScope = normalizeDeleteScope(scope)

  await getActiveParticipant(
    safeConversationId,
    safeUserId
  )

  const { data, error } = await supabase.rpc(
    'delete_chat_conversation_with_retention',
    {
      p_conversation_id: safeConversationId,
      p_user_id: safeUserId,
      p_scope: normalizedScope,
    }
  )

  if (error) {
    throw mapDeleteError(error)
  }

  return {
    ...(data || {}),
    retention_days: 90,
    admin_evidence_available: true,
  }
}

export async function deleteConversationForUser({
  userId,
  conversationId,
}) {
  return deleteConversation({
    userId,
    conversationId,
    scope: 'for_me',
  })
}

export async function deleteConversationForBoth({
  userId,
  conversationId,
}) {
  return deleteConversation({
    userId,
    conversationId,
    scope: 'for_both',
  })
}
