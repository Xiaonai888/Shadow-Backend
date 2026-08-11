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
      'id, conversation_id, user_id, participant_role, archived_at, deleted_at, cleared_at, retention_until, last_read_at, is_muted, muted_until, pinned_at'
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
      'conversation_id, is_muted, muted_until, pinned_at'
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
        is_pinned: Boolean(participant?.pinned_at),
        pinned_at: participant?.pinned_at || null,
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

async function getOwnedChatFolder(folderId, userId) {
  const safeFolderId = requireUuid(folderId, 'Folder ID')
  const safeUserId = requireUuid(userId, 'User ID')

  const { data, error } = await supabase
    .from('chat_folders')
    .select('id, user_id, name')
    .eq('id', safeFolderId)
    .eq('user_id', safeUserId)
    .maybeSingle()

  if (error) {
    throw databaseFailure(
      error,
      'Failed to load chat folder'
    )
  }

  if (!data) {
    fail(
      404,
      'CHAT_FOLDER_NOT_FOUND',
      'Chat folder not found'
    )
  }

  return data
}

export async function addConversationToFolder({
  userId,
  folderId,
  conversationId,
}) {
  const safeUserId = requireUuid(userId, 'User ID')
  const participant = await getActiveParticipant(
    conversationId,
    safeUserId
  )
  const folder = await getOwnedChatFolder(
    folderId,
    safeUserId
  )

  const { error } = await supabase
    .from('chat_folder_conversations')
    .insert({
      folder_id: folder.id,
      conversation_id: participant.conversation_id,
    })

  if (error && error.code !== '23505') {
    throw databaseFailure(
      error,
      'Failed to add chat to folder'
    )
  }

  return {
    folder_id: folder.id,
    conversation_id: participant.conversation_id,
    added: true,
  }
}

export async function removeConversationFromFolder({
  userId,
  folderId,
  conversationId,
}) {
  const safeUserId = requireUuid(userId, 'User ID')
  const participant = await getActiveParticipant(
    conversationId,
    safeUserId
  )
  const folder = await getOwnedChatFolder(
    folderId,
    safeUserId
  )

  const { error } = await supabase
    .from('chat_folder_conversations')
    .delete()
    .eq('folder_id', folder.id)
    .eq(
      'conversation_id',
      participant.conversation_id
    )

  if (error) {
    throw databaseFailure(
      error,
      'Failed to remove chat from folder'
    )
  }

  return {
    folder_id: folder.id,
    conversation_id: participant.conversation_id,
    added: false,
  }
}


export async function listChatFolders({ userId }) {
  const safeUserId = requireUuid(userId, 'User ID')

  const { data, error } = await supabase
    .from('chat_folders')
    .select('id, name, created_at, updated_at')
    .eq('user_id', safeUserId)
    .order('created_at', { ascending: true })

  if (error) {
    throw databaseFailure(error, 'Failed to load chat folders')
  }

  return data || []
}

export async function createChatFolder({
  userId,
  name,
}) {
  const safeUserId = requireUuid(userId, 'User ID')
  const safeName = String(name || '').trim().slice(0, 40)

  if (!safeName) {
    fail(400, 'CHAT_FOLDER_NAME_REQUIRED', 'Folder name is required')
  }

  const { data, error } = await supabase
    .from('chat_folders')
    .insert({ user_id: safeUserId, name: safeName })
    .select('id, name, created_at, updated_at')
    .single()

  if (error?.code === '23505') {
    fail(409, 'CHAT_FOLDER_ALREADY_EXISTS', 'A folder with this name already exists')
  }

  if (error) {
    throw databaseFailure(error, 'Failed to create chat folder')
  }

  return data
}


export async function clearConversationHistory({
  userId,
  conversationId,
}) {
  const participant = await getActiveParticipant(
    conversationId,
    userId
  )
  const clearedAt = new Date().toISOString()

  const { error } = await supabase
    .from('chat_participants')
    .update({
      cleared_at: clearedAt,
      last_read_at: clearedAt,
    })
    .eq('id', participant.id)
    .is('deleted_at', null)

  if (error) {
    throw databaseFailure(
      error,
      'Failed to clear conversation history'
    )
  }

  return {
    conversation_id: participant.conversation_id,
    cleared_at: clearedAt,
  }
}

export async function markConversationUnread({
  userId,
  conversationId,
}) {
  const safeUserId = requireUuid(userId, 'User ID')
  const participant = await getActiveParticipant(
    conversationId,
    safeUserId
  )

  const {
    data: conversation,
    error: conversationError,
  } = await supabase
    .from('chat_conversations')
    .select('id, cleared_for_all_at')
    .eq('id', participant.conversation_id)
    .maybeSingle()

  if (conversationError) {
    throw databaseFailure(
      conversationError,
      'Failed to load conversation'
    )
  }

  if (!conversation) {
    fail(
      404,
      'CONVERSATION_NOT_FOUND',
      'Conversation not found'
    )
  }

  const cutoffTimes = [
    participant.cleared_at,
    conversation.cleared_for_all_at,
  ]
    .filter(Boolean)
    .map((value) => new Date(value).getTime())
    .filter(Number.isFinite)

  let latestQuery = supabase
    .from('chat_messages')
    .select('id, created_at')
    .eq(
      'conversation_id',
      participant.conversation_id
    )
    .neq('sender_user_id', safeUserId)
    .is('deleted_at', null)
    .order('created_at', {
      ascending: false,
    })
    .limit(1)

  if (cutoffTimes.length) {
    latestQuery = latestQuery.gt(
      'created_at',
      new Date(
        Math.max(...cutoffTimes)
      ).toISOString()
    )
  }

  const {
    data: latestIncoming,
    error: latestError,
  } = await latestQuery.maybeSingle()

  if (latestError) {
    throw databaseFailure(
      latestError,
      'Failed to find received message'
    )
  }

  if (!latestIncoming) {
    fail(
      409,
      'NO_RECEIVED_MESSAGE',
      'No received message is available to mark as unread'
    )
  }

  const latestTime = new Date(
    latestIncoming.created_at
  ).getTime()

  const lastReadTime = participant.last_read_at
    ? new Date(
        participant.last_read_at
      ).getTime()
    : NaN

  if (
    !Number.isFinite(lastReadTime) ||
    lastReadTime < latestTime
  ) {
    return {
      conversation_id:
        participant.conversation_id,
      is_unread: true,
      last_read_at:
        participant.last_read_at || null,
    }
  }

  const lastReadAt = new Date(
    latestTime - 1
  ).toISOString()

  const { error } = await supabase
    .from('chat_participants')
    .update({
      last_read_at: lastReadAt,
    })
    .eq('id', participant.id)
    .is('deleted_at', null)

  if (error) {
    throw databaseFailure(
      error,
      'Failed to mark conversation as unread'
    )
  }

  return {
    conversation_id:
      participant.conversation_id,
    is_unread: true,
    last_read_at: lastReadAt,
  }
}

export async function pinConversation({
  userId,
  conversationId,
}) {
  const safeUserId = requireUuid(userId, 'User ID')
  const participant = await getActiveParticipant(
    conversationId,
    safeUserId
  )

  if (participant.pinned_at) {
    return {
      conversation_id: participant.conversation_id,
      is_pinned: true,
      pinned_at: participant.pinned_at,
    }
  }

  const { count, error: countError } = await supabase
    .from('chat_participants')
    .select('id', {
      count: 'exact',
      head: true,
    })
    .eq('user_id', safeUserId)
    .is('deleted_at', null)
    .not('pinned_at', 'is', null)

  if (countError) {
    throw databaseFailure(
      countError,
      'Failed to check pinned chats'
    )
  }

  if (Number(count || 0) >= 5) {
    fail(
      409,
      'CHAT_PIN_LIMIT',
      'You can pin up to 5 chats.'
    )
  }

  const pinnedAt = new Date().toISOString()

  const { error } = await supabase
    .from('chat_participants')
    .update({
      pinned_at: pinnedAt,
    })
    .eq('id', participant.id)
    .is('deleted_at', null)

  if (error) {
    throw databaseFailure(
      error,
      'Failed to pin conversation'
    )
  }

  return {
    conversation_id: participant.conversation_id,
    is_pinned: true,
    pinned_at: pinnedAt,
  }
}

export async function unpinConversation({
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
      pinned_at: null,
    })
    .eq('id', participant.id)
    .is('deleted_at', null)

  if (error) {
    throw databaseFailure(
      error,
      'Failed to unpin conversation'
    )
  }

  return {
    conversation_id: participant.conversation_id,
    is_pinned: false,
    pinned_at: null,
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
