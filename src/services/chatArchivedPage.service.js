import { supabase } from '../config/supabase.js'
import { ChatServiceError, buildConversationSummary } from './chat.service.js'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export async function listArchivedChatPage({ userId, role, page = 1, limit = 20 }) {
  const safeUserId = String(userId || '').trim()
  const safeRole = String(role || '').trim().toLowerCase()
  const parsedPage = Number(page)
  const parsedLimit = Number(limit)

  if (!UUID_PATTERN.test(safeUserId)) {
    throw new ChatServiceError(401, 'USER_REQUIRED', 'Reader account is required')
  }
  if (safeRole !== 'reader' && safeRole !== 'author') {
    throw new ChatServiceError(400, 'INVALID_CHAT_ROLE', 'Chat role is not valid')
  }
  if (!Number.isInteger(parsedPage) || parsedPage < 1 || parsedPage > 1000) {
    throw new ChatServiceError(400, 'INVALID_PAGE', 'Page is not valid')
  }
  if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 20) {
    throw new ChatServiceError(400, 'INVALID_LIMIT', 'Limit must be between 1 and 20')
  }

  const offset = (parsedPage - 1) * parsedLimit
  const { data: rows, error: participantsError } = await supabase
    .from('chat_participants')
    .select('id, conversation_id, user_id, participant_role, last_read_at, cleared_at, archived_at, is_muted, muted_until, pinned_at, notification_sound_enabled, notification_tone')
    .eq('user_id', safeUserId)
    .eq('participant_role', safeRole)
    .is('deleted_at', null)
    .not('archived_at', 'is', null)
    .order('archived_at', { ascending: false })
    .order('id', { ascending: false })
    .range(offset, offset + parsedLimit)

  if (participantsError) {
    throw new ChatServiceError(500, 'CHAT_DATABASE_ERROR', 'Failed to load archived conversations')
  }

  const participantRows = (rows || []).slice(0, parsedLimit)
  const hasMore = (rows || []).length > parsedLimit
  if (!participantRows.length) {
    return {
      conversations: [],
      pagination: { page: parsedPage, limit: parsedLimit, has_more: false, next_page: null },
    }
  }

  const { data: conversationRows, error: conversationsError } = await supabase
    .from('chat_conversations')
    .select('id, conversation_type, direct_key, created_by_user_id, author_page_id, request_status, request_decided_at, last_message_at, cleared_for_all_at, is_group, group_name, group_avatar_url, created_at, updated_at')
    .in('id', participantRows.map((row) => row.conversation_id))
    .limit(parsedLimit)

  if (conversationsError) {
    throw new ChatServiceError(500, 'CHAT_DATABASE_ERROR', 'Failed to load archived conversations')
  }

  const byId = new Map((conversationRows || []).map((row) => [String(row.id), row]))
  const conversations = await Promise.all(
    participantRows
      .filter((participant) => byId.has(String(participant.conversation_id)))
      .map(async (participant) => ({
        ...await buildConversationSummary(
          byId.get(String(participant.conversation_id)),
          participant
        ),
        is_muted: Boolean(participant.is_muted) && (
          !participant.muted_until || new Date(participant.muted_until).getTime() > Date.now()
        ),
        muted_until: participant.muted_until || null,
        is_pinned: Boolean(participant.pinned_at),
        pinned_at: participant.pinned_at || null,
        notification_sound_enabled: participant.notification_sound_enabled !== false,
        notification_tone: participant.notification_tone || 'default',
        delete_permissions: {
          can_delete_for_me: true,
          can_delete_for_both: byId.get(String(participant.conversation_id)).conversation_type === 'reader_reader',
          retention_days: 90,
        },
      }))
  )

  return {
    conversations,
    pagination: {
      page: parsedPage,
      limit: parsedLimit,
      has_more: hasMore,
      next_page: hasMore ? parsedPage + 1 : null,
    },
  }
}
