import { supabase } from '../config/supabase.js'

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const RESTORABLE_STATUSES = [
  'pending',
  'accepted',
  'declined',
]

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

async function getBlockAccess({
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

  const [
    {
      data: conversation,
      error: conversationError,
    },
    {
      data: participant,
      error: participantError,
    },
  ] = await Promise.all([
    supabase
      .from('chat_conversations')
      .select(
        'id, request_status, request_decided_at, status_before_block, request_decided_at_before_block'
      )
      .eq('id', safeConversationId)
      .maybeSingle(),
    supabase
      .from('chat_participants')
      .select('id, user_id')
      .eq(
        'conversation_id',
        safeConversationId
      )
      .eq('user_id', safeUserId)
      .is('deleted_at', null)
      .maybeSingle(),
  ])

  if (conversationError || participantError) {
    throw databaseFailure(
      conversationError || participantError,
      'Failed to verify chat access'
    )
  }

  if (!conversation) {
    fail(
      404,
      'CONVERSATION_NOT_FOUND',
      'Conversation not found'
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

  return {
    safeUserId,
    safeConversationId,
    otherUserId:
      otherParticipant.user_id,
    conversation,
  }
}

async function getBlockRows(
  firstUserId,
  secondUserId
) {
  const { data, error } = await supabase
    .from('chat_blocks')
    .select(
      'id, blocker_user_id, blocked_user_id, created_at'
    )
    .or(
      `and(blocker_user_id.eq.${firstUserId},blocked_user_id.eq.${secondUserId}),and(blocker_user_id.eq.${secondUserId},blocked_user_id.eq.${firstUserId})`
    )

  if (error) {
    throw databaseFailure(
      error,
      'Failed to load block status'
    )
  }

  return data || []
}

function buildBlockStatus(
  rows,
  viewerUserId,
  otherUserId
) {
  const viewerHasBlocked = rows.some(
    (row) =>
      String(row.blocker_user_id) ===
        String(viewerUserId) &&
      String(row.blocked_user_id) ===
        String(otherUserId)
  )

  const viewerIsBlocked = rows.some(
    (row) =>
      String(row.blocker_user_id) ===
        String(otherUserId) &&
      String(row.blocked_user_id) ===
        String(viewerUserId)
  )

  return {
    is_blocked:
      viewerHasBlocked || viewerIsBlocked,
    viewer_has_blocked: viewerHasBlocked,
    viewer_is_blocked: viewerIsBlocked,
  }
}

export async function getConversationBlockStatus({
  userId,
  conversationId,
}) {
  const {
    safeUserId,
    otherUserId,
  } = await getBlockAccess({
    userId,
    conversationId,
  })

  const rows = await getBlockRows(
    safeUserId,
    otherUserId
  )

  return buildBlockStatus(
    rows,
    safeUserId,
    otherUserId
  )
}

export async function blockConversation({
  userId,
  conversationId,
}) {
  const {
    safeUserId,
    safeConversationId,
    otherUserId,
    conversation,
  } = await getBlockAccess({
    userId,
    conversationId,
  })

  const { error: blockError } =
    await supabase
      .from('chat_blocks')
      .insert({
        blocker_user_id: safeUserId,
        blocked_user_id: otherUserId,
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

  const updatePayload = {
    request_status: 'blocked',
    request_decided_at:
      new Date().toISOString(),
  }

  if (
    conversation.request_status !==
    'blocked'
  ) {
    updatePayload.status_before_block =
      conversation.request_status
    updatePayload.request_decided_at_before_block =
      conversation.request_decided_at
  }

  const {
    data: updatedConversation,
    error: conversationError,
  } = await supabase
    .from('chat_conversations')
    .update(updatePayload)
    .eq('id', safeConversationId)
    .select(
      'id, request_status, status_before_block'
    )
    .single()

  if (conversationError) {
    throw databaseFailure(
      conversationError,
      'Failed to block conversation'
    )
  }

  const rows = await getBlockRows(
    safeUserId,
    otherUserId
  )

  return {
    conversation: updatedConversation,
    block_status: buildBlockStatus(
      rows,
      safeUserId,
      otherUserId
    ),
  }
}

export async function unblockConversation({
  userId,
  conversationId,
}) {
  const {
    safeUserId,
    safeConversationId,
    otherUserId,
    conversation,
  } = await getBlockAccess({
    userId,
    conversationId,
  })

  const { error: deleteError } =
    await supabase
      .from('chat_blocks')
      .delete()
      .eq('blocker_user_id', safeUserId)
      .eq('blocked_user_id', otherUserId)

  if (deleteError) {
    throw databaseFailure(
      deleteError,
      'Failed to unblock account'
    )
  }

  const remainingRows = await getBlockRows(
    safeUserId,
    otherUserId
  )

  let updatedConversation = {
    id: safeConversationId,
    request_status:
      conversation.request_status,
  }

  if (!remainingRows.length) {
    const restoredStatus =
      RESTORABLE_STATUSES.includes(
        conversation.status_before_block
      )
        ? conversation.status_before_block
        : 'pending'

    const {
      data,
      error: restoreError,
    } = await supabase
      .from('chat_conversations')
      .update({
        request_status: restoredStatus,
        request_decided_at:
          conversation
            .request_decided_at_before_block,
        status_before_block: null,
        request_decided_at_before_block:
          null,
      })
      .eq('id', safeConversationId)
      .select(
        'id, request_status, status_before_block'
      )
      .single()

    if (restoreError) {
      throw databaseFailure(
        restoreError,
        'Failed to restore conversation'
      )
    }

    updatedConversation = data
  }

  return {
    conversation: updatedConversation,
    block_status: buildBlockStatus(
      remainingRows,
      safeUserId,
      otherUserId
    ),
  }
}
