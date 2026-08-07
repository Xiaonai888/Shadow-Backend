import { supabase } from '../config/supabase.js'
import {
  ChatServiceError,
  listMyConversations,
} from './chat.service.js'

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const MUTE_DURATION_MS = {
  '1h': 60 * 60 * 1000,
  '8h': 8 * 60 * 60 * 1000,
  '1d': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
}

const AUTO_DELETE_SECONDS = new Set([
  24 * 60 * 60,
  7 * 24 * 60 * 60,
  30 * 24 * 60 * 60,
])

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

function normalizeMuteDuration(value) {
  const normalized = String(value || 'forever')
    .trim()
    .toLowerCase()

  if (
    normalized === 'forever' ||
    Object.prototype.hasOwnProperty.call(
      MUTE_DURATION_MS,
      normalized
    )
  ) {
    return normalized
  }

  fail(
    400,
    'INVALID_MUTE_DURATION',
    'Mute duration is not valid'
  )
}

function normalizeAutoDeleteSeconds(value) {
  if (
    value === null ||
    value === undefined ||
    value === '' ||
    value === 0 ||
    value === '0' ||
    String(value).trim().toLowerCase() === 'off'
  ) {
    return null
  }

  const seconds = Number(value)

  if (
    !Number.isInteger(seconds) ||
    !AUTO_DELETE_SECONDS.has(seconds)
  ) {
    fail(
      400,
      'INVALID_AUTO_DELETE_DURATION',
      'Auto-delete duration is not valid'
    )
  }

  return seconds
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

function isParticipantMuted(participant) {
  if (!participant?.is_muted) return false
  if (!participant.muted_until) return true

  const mutedUntilTime =
    new Date(participant.muted_until).getTime()

  return (
    Number.isFinite(mutedUntilTime) &&
    mutedUntilTime > Date.now()
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
      'id, conversation_id, user_id, participant_role, archived_at, deleted_at, cleared_at, retention_until, last_read_at, is_muted, muted_until'
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
    .select(
      'conversation_id, is_muted, muted_until'
    )
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

  const participantMap = new Map(
    data.map((item) => [
      String(item.conversation_id),
      item,
    ])
  )
  const allowedIds = new Set(participantMap.keys())
  const conversations = await listMyConversations({
    userId: safeUserId,
    status,
  })

  return conversations
    .filter((conversation) =>
      allowedIds.has(String(conversation.id))
    )
    .map((conversation) => {
      const participant =
        participantMap.get(String(conversation.id))

      return {
        ...conversation,
        is_muted: isParticipantMuted(participant),
        muted_until: participant?.muted_until || null,
        delete_permissions: {
          can_delete_for_me: true,
          can_delete_for_both:
            conversation.conversation_type ===
            'reader_reader',
          retention_days: 90,
        },
      }
    })
}

export async function getConversationMuteStatus({
  userId,
  conversationId,
}) {
  const participant = await getActiveParticipant(
    conversationId,
    userId
  )
  const isMuted = isParticipantMuted(participant)

  if (participant.is_muted && !isMuted) {
    const { error } = await supabase
      .from('chat_participants')
      .update({
        is_muted: false,
        muted_until: null,
      })
      .eq('id', participant.id)
      .is('deleted_at', null)

    if (error) {
      throw databaseFailure(
        error,
        'Failed to refresh mute status'
      )
    }
  }

  return {
    conversation_id: participant.conversation_id,
    is_muted: isMuted,
    muted_until: isMuted
      ? participant.muted_until || null
      : null,
  }
}

export async function muteConversation({
  userId,
  conversationId,
  duration,
}) {
  const participant = await getActiveParticipant(
    conversationId,
    userId
  )
  const safeDuration =
    normalizeMuteDuration(duration)
  const mutedUntil =
    safeDuration === 'forever'
      ? null
      : new Date(
          Date.now() +
            MUTE_DURATION_MS[safeDuration]
        ).toISOString()

  const { error } = await supabase
    .from('chat_participants')
    .update({
      is_muted: true,
      muted_until: mutedUntil,
    })
    .eq('id', participant.id)
    .is('deleted_at', null)

  if (error) {
    throw databaseFailure(
      error,
      'Failed to mute conversation'
    )
  }

  return {
    conversation_id: participant.conversation_id,
    is_muted: true,
    muted_until: mutedUntil,
    duration: safeDuration,
  }
}

export async function unmuteConversation({
  userId,
  conversationId,
}) {
  const participant = await getActiveParticipant(
    conversationId,
    userId
  )

  const { error } = await supabase
    .from('chat_participants')
    .update({
      is_muted: false,
      muted_until: null,
    })
    .eq('id', participant.id)
    .is('deleted_at', null)

  if (error) {
    throw databaseFailure(
      error,
      'Failed to unmute conversation'
    )
  }

  return {
    conversation_id: participant.conversation_id,
    is_muted: false,
    muted_until: null,
  }
}

export async function getConversationAutoDeleteStatus({
  userId,
  conversationId,
}) {
  const participant = await getActiveParticipant(
    conversationId,
    userId
  )

  const { data, error } = await supabase
    .from('chat_conversations')
    .select(
      'id, auto_delete_seconds, auto_delete_updated_by_user_id, auto_delete_updated_at'
    )
    .eq('id', participant.conversation_id)
    .maybeSingle()

  if (error) {
    throw databaseFailure(
      error,
      'Failed to load auto-delete settings'
    )
  }

  if (!data) {
    fail(
      404,
      'CONVERSATION_NOT_FOUND',
      'Conversation not found'
    )
  }

  return {
    conversation_id: data.id,
    auto_delete_seconds:
      Number(data.auto_delete_seconds || 0),
    auto_delete_enabled:
      Number(data.auto_delete_seconds || 0) > 0,
    updated_by_user_id:
      data.auto_delete_updated_by_user_id || null,
    updated_at:
      data.auto_delete_updated_at || null,
  }
}

export async function setConversationAutoDelete({
  userId,
  conversationId,
  seconds,
}) {
  const safeUserId = requireUuid(
    userId,
    'User ID'
  )
  const participant = await getActiveParticipant(
    conversationId,
    safeUserId
  )
  const safeSeconds =
    normalizeAutoDeleteSeconds(seconds)
  const updatedAt = new Date().toISOString()

  const { data, error } = await supabase
    .from('chat_conversations')
    .update({
      auto_delete_seconds: safeSeconds,
      auto_delete_updated_by_user_id:
        safeUserId,
      auto_delete_updated_at: updatedAt,
    })
    .eq('id', participant.conversation_id)
    .select(
      'id, auto_delete_seconds, auto_delete_updated_by_user_id, auto_delete_updated_at'
    )
    .single()

  if (error) {
    throw databaseFailure(
      error,
      'Failed to update auto-delete settings'
    )
  }

  return {
    conversation_id: data.id,
    auto_delete_seconds:
      Number(data.auto_delete_seconds || 0),
    auto_delete_enabled:
      Number(data.auto_delete_seconds || 0) > 0,
    updated_by_user_id:
      data.auto_delete_updated_by_user_id || null,
    updated_at:
      data.auto_delete_updated_at || null,
  }
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
