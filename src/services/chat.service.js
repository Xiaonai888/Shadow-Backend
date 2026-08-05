import { supabase } from '../config/supabase.js'

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const REQUEST_STATUSES = [
  'pending',
  'accepted',
  'declined',
  'blocked',
]

export class ChatServiceError extends Error {
  constructor(status, code, message) {
    super(message)
    this.name = 'ChatServiceError'
    this.status = status
    this.code = code
  }
}

function fail(status, code, message) {
  throw new ChatServiceError(status, code, message)
}

function cleanText(value, maxLength = 2000) {
  return String(value || '').trim().slice(0, maxLength)
}

function requireUuid(value, fieldName) {
  const id = cleanText(value, 100)

  if (!UUID_PATTERN.test(id)) {
    fail(400, 'INVALID_ID', `${fieldName} is not valid`)
  }

  return id
}

function requireMessage(value) {
  const message = cleanText(value, 2000)

  if (!message) {
    fail(400, 'MESSAGE_REQUIRED', 'Message is required')
  }

  return message
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

async function getAuthorPage(authorPageId) {
  const { data, error } = await supabase
    .from('author_pages')
    .select(
      'id, user_id, page_name, page_username, page_slug, avatar_url, status'
    )
    .eq('id', authorPageId)
    .eq('status', 'active')
    .maybeSingle()

  if (error) {
    throw databaseFailure(error, 'Failed to load author page')
  }

  if (!data) {
    fail(404, 'AUTHOR_PAGE_NOT_FOUND', 'Author page not found')
  }

  return data
}

async function getConversation(conversationId) {
  const { data, error } = await supabase
    .from('chat_conversations')
    .select(
      'id, conversation_type, direct_key, created_by_user_id, author_page_id, request_status, request_decided_at, last_message_at, created_at, updated_at'
    )
    .eq('id', conversationId)
    .maybeSingle()

  if (error) {
    throw databaseFailure(error, 'Failed to load conversation')
  }

  if (!data) {
    fail(404, 'CONVERSATION_NOT_FOUND', 'Conversation not found')
  }

  return data
}

async function getViewerParticipant(conversationId, userId) {
  const { data, error } = await supabase
    .from('chat_participants')
    .select(
      'id, conversation_id, user_id, participant_role, last_read_at, muted_at, deleted_at, created_at'
    )
    .eq('conversation_id', conversationId)
    .eq('user_id', userId)
    .is('deleted_at', null)
    .maybeSingle()

  if (error) {
    throw databaseFailure(error, 'Failed to verify chat access')
  }

  if (!data) {
    fail(403, 'CHAT_ACCESS_DENIED', 'You cannot access this conversation')
  }

  return data
}

async function getConversationAccess(conversationId, userId) {
  const safeConversationId = requireUuid(
    conversationId,
    'Conversation ID'
  )

  const [conversation, participant] = await Promise.all([
    getConversation(safeConversationId),
    getViewerParticipant(safeConversationId, userId),
  ])

  return {
    conversation,
    participant,
  }
}

async function getOtherParticipant(conversationId, userId) {
  const { data, error } = await supabase
    .from('chat_participants')
    .select(
      'id, conversation_id, user_id, participant_role, last_read_at, muted_at, deleted_at, created_at'
    )
    .eq('conversation_id', conversationId)
    .neq('user_id', userId)
    .is('deleted_at', null)
    .limit(1)
    .maybeSingle()

  if (error) {
    throw databaseFailure(error, 'Failed to load chat participant')
  }

  return data || null
}

async function getPublicUser(userId) {
  if (!userId) return null

  const { data, error } = await supabase
    .from('users')
    .select('id, name, username, avatar_url, is_author, is_active')
    .eq('id', userId)
    .maybeSingle()

  if (error) {
    throw databaseFailure(error, 'Failed to load user profile')
  }

  return data || null
}

async function getActiveUser(userId) {
  const safeUserId = requireUuid(userId, 'Reader user ID')

  const { data, error } = await supabase
    .from('users')
    .select('id, name, username, avatar_url, is_author, is_active')
    .eq('id', safeUserId)
    .eq('is_active', true)
    .maybeSingle()

  if (error) {
    throw databaseFailure(error, 'Failed to load reader profile')
  }

  if (!data) {
    fail(404, 'READER_NOT_FOUND', 'Reader account not found')
  }

  return data
}

async function findBlockBetween(firstUserId, secondUserId) {
  if (!firstUserId || !secondUserId) return null

  const [
    { data: firstBlock, error: firstError },
    { data: secondBlock, error: secondError },
  ] = await Promise.all([
    supabase
      .from('chat_blocks')
      .select('id, blocker_user_id, blocked_user_id, created_at')
      .eq('blocker_user_id', firstUserId)
      .eq('blocked_user_id', secondUserId)
      .maybeSingle(),
    supabase
      .from('chat_blocks')
      .select('id, blocker_user_id, blocked_user_id, created_at')
      .eq('blocker_user_id', secondUserId)
      .eq('blocked_user_id', firstUserId)
      .maybeSingle(),
  ])

  if (firstError || secondError) {
    throw databaseFailure(
      firstError || secondError,
      'Failed to verify chat block status'
    )
  }

  return firstBlock || secondBlock || null
}

async function getLatestMessage(conversationId) {
  const { data, error } = await supabase
    .from('chat_messages')
    .select(
      'id, sender_user_id, message_type, body, is_request_message, created_at'
    )
    .eq('conversation_id', conversationId)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) {
    throw databaseFailure(error, 'Failed to load latest message')
  }

  return data || null
}

async function getUnreadCount(
  conversationId,
  userId,
  lastReadAt
) {
  let query = supabase
    .from('chat_messages')
    .select('id', { count: 'exact', head: true })
    .eq('conversation_id', conversationId)
    .neq('sender_user_id', userId)
    .is('deleted_at', null)

  if (lastReadAt) {
    query = query.gt('created_at', lastReadAt)
  }

  const { count, error } = await query

  if (error) {
    throw databaseFailure(error, 'Failed to count unread messages')
  }

  return Number(count || 0)
}

async function buildConversationSummary(
  conversation,
  viewerParticipant
) {
  const [otherParticipant, authorPage, latestMessage, unreadCount] =
    await Promise.all([
      getOtherParticipant(
        conversation.id,
        viewerParticipant.user_id
      ),
      conversation.author_page_id
        ? getAuthorPage(conversation.author_page_id)
        : Promise.resolve(null),
      getLatestMessage(conversation.id),
      getUnreadCount(
        conversation.id,
        viewerParticipant.user_id,
        viewerParticipant.last_read_at
      ),
    ])

  const otherUser = await getPublicUser(otherParticipant?.user_id)

  const counterpart =
    viewerParticipant.participant_role === 'reader' && authorPage
      ? {
          type: 'author',
          user_id: authorPage.user_id,
          author_page_id: authorPage.id,
          name: authorPage.page_name,
          username: authorPage.page_username,
          avatar_url: authorPage.avatar_url || null,
        }
      : {
          type: otherParticipant?.participant_role || 'reader',
          user_id: otherUser?.id || otherParticipant?.user_id || null,
          author_page_id: null,
          name: otherUser?.name || 'Shadow Reader',
          username: otherUser?.username || '',
          avatar_url: otherUser?.avatar_url || null,
        }

  return {
    id: conversation.id,
    conversation_type: conversation.conversation_type,
    request_status: conversation.request_status,
    viewer_role: viewerParticipant.participant_role,
    created_by_user_id: conversation.created_by_user_id,
    author_page_id: conversation.author_page_id,
    counterpart,
    latest_message: latestMessage,
    unread_count: unreadCount,
    can_send: conversation.request_status === 'accepted',
    can_decide:
      conversation.request_status === 'pending' &&
      String(conversation.created_by_user_id) !==
        String(viewerParticipant.user_id),
    last_read_at: viewerParticipant.last_read_at,
    last_message_at: conversation.last_message_at,
    created_at: conversation.created_at,
    updated_at: conversation.updated_at,
  }
}

async function getConversationSummaryForUser(
  conversationId,
  userId
) {
  const { conversation, participant } =
    await getConversationAccess(conversationId, userId)

  return buildConversationSummary(conversation, participant)
}

async function getExistingDirectConversation(directKey) {
  const { data, error } = await supabase
    .from('chat_conversations')
    .select(
      'id, conversation_type, direct_key, created_by_user_id, author_page_id, request_status, request_decided_at, last_message_at, created_at, updated_at'
    )
    .eq('direct_key', directKey)
    .maybeSingle()

  if (error) {
    throw databaseFailure(
      error,
      'Failed to check existing conversation'
    )
  }

  return data || null
}

function handleExistingRequestStatus(conversation) {
  if (conversation.request_status === 'blocked') {
    fail(403, 'CHAT_BLOCKED', 'Messaging is blocked')
  }

  if (conversation.request_status === 'declined') {
    fail(
      409,
      'REQUEST_DECLINED',
      'This message request was declined'
    )
  }
}

export async function createReaderAuthorRequest({
  readerUserId,
  authorPageId,
  message,
}) {
  const safeReaderUserId = requireUuid(
    readerUserId,
    'Reader user ID'
  )
  const safeAuthorPageId = requireUuid(
    authorPageId,
    'Author page ID'
  )
  const safeMessage = requireMessage(message)
  const authorPage = await getAuthorPage(safeAuthorPageId)

  if (String(authorPage.user_id) === safeReaderUserId) {
    fail(
      400,
      'CANNOT_MESSAGE_SELF',
      'You cannot message your own author page'
    )
  }

  const block = await findBlockBetween(
    safeReaderUserId,
    authorPage.user_id
  )

  if (block) {
    fail(403, 'CHAT_BLOCKED', 'Messaging is blocked')
  }

  const directKey =
    `reader_author:${safeReaderUserId}:${safeAuthorPageId}`

  const existing = await getExistingDirectConversation(directKey)

  if (existing) {
    handleExistingRequestStatus(existing)

    return {
      created: false,
      conversation:
        await getConversationSummaryForUser(
          existing.id,
          safeReaderUserId
        ),
    }
  }

  const {
    data: conversation,
    error: conversationError,
  } = await supabase
    .from('chat_conversations')
    .insert({
      conversation_type: 'reader_author',
      direct_key: directKey,
      created_by_user_id: safeReaderUserId,
      author_page_id: safeAuthorPageId,
      request_status: 'pending',
    })
    .select(
      'id, conversation_type, direct_key, created_by_user_id, author_page_id, request_status, request_decided_at, last_message_at, created_at, updated_at'
    )
    .single()

  if (conversationError) {
    if (conversationError.code === '23505') {
      const racedConversation =
        await getExistingDirectConversation(directKey)

      if (racedConversation) {
        handleExistingRequestStatus(racedConversation)

        return {
          created: false,
          conversation:
            await getConversationSummaryForUser(
              racedConversation.id,
              safeReaderUserId
            ),
        }
      }
    }

    throw databaseFailure(
      conversationError,
      'Failed to create message request'
    )
  }

  try {
    const now = new Date().toISOString()

    const { error: participantsError } = await supabase
      .from('chat_participants')
      .insert([
        {
          conversation_id: conversation.id,
          user_id: safeReaderUserId,
          participant_role: 'reader',
          last_read_at: now,
        },
        {
          conversation_id: conversation.id,
          user_id: authorPage.user_id,
          participant_role: 'author',
        },
      ])

    if (participantsError) {
      throw participantsError
    }

    const { error: messageError } = await supabase
      .from('chat_messages')
      .insert({
        conversation_id: conversation.id,
        sender_user_id: safeReaderUserId,
        message_type: 'text',
        body: safeMessage,
        is_request_message: true,
      })

    if (messageError) {
      throw messageError
    }
  } catch (error) {
    await supabase
      .from('chat_conversations')
      .delete()
      .eq('id', conversation.id)

    throw databaseFailure(
      error,
      'Failed to save message request'
    )
  }

  return {
    created: true,
    conversation:
      await getConversationSummaryForUser(
        conversation.id,
        safeReaderUserId
      ),
  }
}

export async function createReaderReaderRequest({
  senderUserId,
  targetUserId,
  message,
}) {
  const safeSenderUserId = requireUuid(
    senderUserId,
    'Sender user ID'
  )
  const safeTargetUserId = requireUuid(
    targetUserId,
    'Reader user ID'
  )
  const safeMessage = requireMessage(message)

  if (safeSenderUserId === safeTargetUserId) {
    fail(
      400,
      'CANNOT_MESSAGE_SELF',
      'You cannot message yourself'
    )
  }

  const targetUser = await getActiveUser(safeTargetUserId)
  const block = await findBlockBetween(
    safeSenderUserId,
    targetUser.id
  )

  if (block) {
    fail(403, 'CHAT_BLOCKED', 'Messaging is blocked')
  }

  const sortedUserIds = [
    safeSenderUserId,
    targetUser.id,
  ].sort()

  const directKey =
    `reader_reader:${sortedUserIds[0]}:${sortedUserIds[1]}`

  const existing = await getExistingDirectConversation(directKey)

  if (existing) {
    handleExistingRequestStatus(existing)

    return {
      created: false,
      conversation:
        await getConversationSummaryForUser(
          existing.id,
          safeSenderUserId
        ),
    }
  }

  const {
    data: conversation,
    error: conversationError,
  } = await supabase
    .from('chat_conversations')
    .insert({
      conversation_type: 'reader_reader',
      direct_key: directKey,
      created_by_user_id: safeSenderUserId,
      author_page_id: null,
      request_status: 'pending',
    })
    .select(
      'id, conversation_type, direct_key, created_by_user_id, author_page_id, request_status, request_decided_at, last_message_at, created_at, updated_at'
    )
    .single()

  if (conversationError) {
    if (conversationError.code === '23505') {
      const racedConversation =
        await getExistingDirectConversation(directKey)

      if (racedConversation) {
        handleExistingRequestStatus(racedConversation)

        return {
          created: false,
          conversation:
            await getConversationSummaryForUser(
              racedConversation.id,
              safeSenderUserId
            ),
        }
      }
    }

    throw databaseFailure(
      conversationError,
      'Failed to create reader message request'
    )
  }

  try {
    const now = new Date().toISOString()

    const { error: participantsError } = await supabase
      .from('chat_participants')
      .insert([
        {
          conversation_id: conversation.id,
          user_id: safeSenderUserId,
          participant_role: 'reader',
          last_read_at: now,
        },
        {
          conversation_id: conversation.id,
          user_id: targetUser.id,
          participant_role: 'reader',
        },
      ])

    if (participantsError) {
      throw participantsError
    }

    const { error: messageError } = await supabase
      .from('chat_messages')
      .insert({
        conversation_id: conversation.id,
        sender_user_id: safeSenderUserId,
        message_type: 'text',
        body: safeMessage,
        is_request_message: true,
      })

    if (messageError) {
      throw messageError
    }
  } catch (error) {
    await supabase
      .from('chat_conversations')
      .delete()
      .eq('id', conversation.id)

    throw databaseFailure(
      error,
      'Failed to save reader message request'
    )
  }

  return {
    created: true,
    conversation:
      await getConversationSummaryForUser(
        conversation.id,
        safeSenderUserId
      ),
  }
}

export async function listMyConversations({
  userId,
  status,
}) {
  const safeUserId = requireUuid(userId, 'User ID')
  const normalizedStatus = cleanText(status, 30).toLowerCase()

  if (
    normalizedStatus &&
    normalizedStatus !== 'all' &&
    !REQUEST_STATUSES.includes(normalizedStatus)
  ) {
    fail(400, 'INVALID_STATUS', 'Chat status is not valid')
  }

  const { data: participantRows, error: participantError } =
    await supabase
      .from('chat_participants')
      .select(
        'id, conversation_id, user_id, participant_role, last_read_at, muted_at, deleted_at, created_at'
      )
      .eq('user_id', safeUserId)
      .is('deleted_at', null)
      .limit(50)

  if (participantError) {
    throw databaseFailure(
      participantError,
      'Failed to load conversations'
    )
  }

  if (!participantRows?.length) {
    return []
  }

  const conversationIds = participantRows.map(
    (item) => item.conversation_id
  )

  let conversationQuery = supabase
    .from('chat_conversations')
    .select(
      'id, conversation_type, direct_key, created_by_user_id, author_page_id, request_status, request_decided_at, last_message_at, created_at, updated_at'
    )
    .in('id', conversationIds)
    .order('last_message_at', {
      ascending: false,
      nullsFirst: false,
    })

  if (
    normalizedStatus &&
    normalizedStatus !== 'all'
  ) {
    conversationQuery = conversationQuery.eq(
      'request_status',
      normalizedStatus
    )
  }

  const { data: conversations, error: conversationError } =
    await conversationQuery

  if (conversationError) {
    throw databaseFailure(
      conversationError,
      'Failed to load conversations'
    )
  }

  const participantMap = new Map(
    participantRows.map((item) => [
      item.conversation_id,
      item,
    ])
  )

  return Promise.all(
    (conversations || []).map((conversation) =>
      buildConversationSummary(
        conversation,
        participantMap.get(conversation.id)
      )
    )
  )
}

export async function getConversationMessages({
  userId,
  conversationId,
  before,
  limit,
}) {
  const safeUserId = requireUuid(userId, 'User ID')
  const {
    conversation,
    participant,
  } = await getConversationAccess(
    conversationId,
    safeUserId
  )

  const safeLimit = Math.min(
    100,
    Math.max(1, Number(limit) || 50)
  )

  let messageQuery = supabase
    .from('chat_messages')
    .select(
      'id, conversation_id, sender_user_id, message_type, body, is_request_message, edited_at, created_at'
    )
    .eq('conversation_id', conversation.id)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(safeLimit)

  if (before) {
    const beforeDate = new Date(before)

    if (Number.isNaN(beforeDate.getTime())) {
      fail(
        400,
        'INVALID_CURSOR',
        'Message cursor is not valid'
      )
    }

    messageQuery = messageQuery.lt(
      'created_at',
      beforeDate.toISOString()
    )
  }

  const { data: messageRows, error: messageError } =
    await messageQuery

  if (messageError) {
    throw databaseFailure(
      messageError,
      'Failed to load messages'
    )
  }

  const messages = [...(messageRows || [])].reverse()
  const senderIds = [
    ...new Set(
      messages
        .map((item) => item.sender_user_id)
        .filter(Boolean)
    ),
  ]

  let senderMap = new Map()

  if (senderIds.length) {
    const { data: senders, error: senderError } =
      await supabase
        .from('users')
        .select('id, name, username, avatar_url')
        .in('id', senderIds)

    if (senderError) {
      throw databaseFailure(
        senderError,
        'Failed to load message senders'
      )
    }

    senderMap = new Map(
      (senders || []).map((item) => [item.id, item])
    )
  }

  const formattedMessages = messages.map((item) => {
    const sender = senderMap.get(item.sender_user_id)

    return {
      ...item,
      sender: sender
        ? {
            id: sender.id,
            name: sender.name,
            username: sender.username,
            avatar_url: sender.avatar_url || null,
          }
        : null,
      is_mine:
        String(item.sender_user_id) === safeUserId,
    }
  })

  return {
    conversation:
      await buildConversationSummary(
        conversation,
        participant
      ),
    messages: formattedMessages,
    next_before:
      messageRows?.length === safeLimit
        ? messages[0]?.created_at || null
        : null,
  }
}

export async function sendConversationMessage({
  userId,
  conversationId,
  message,
}) {
  const safeUserId = requireUuid(userId, 'User ID')
  const safeMessage = requireMessage(message)
  const {
    conversation,
    participant,
  } = await getConversationAccess(
    conversationId,
    safeUserId
  )

  if (conversation.request_status === 'pending') {
    fail(
      409,
      'REQUEST_NOT_ACCEPTED',
      'The recipient must accept this message request first'
    )
  }

  if (conversation.request_status === 'declined') {
    fail(
      403,
      'REQUEST_DECLINED',
      'This message request was declined'
    )
  }

  if (conversation.request_status === 'blocked') {
    fail(403, 'CHAT_BLOCKED', 'Messaging is blocked')
  }

  const otherParticipant = await getOtherParticipant(
    conversation.id,
    safeUserId
  )

  if (!otherParticipant) {
    fail(
      409,
      'PARTICIPANT_MISSING',
      'The other participant is unavailable'
    )
  }

  const block = await findBlockBetween(
    safeUserId,
    otherParticipant.user_id
  )

  if (block) {
    fail(403, 'CHAT_BLOCKED', 'Messaging is blocked')
  }

  const { data, error } = await supabase
    .from('chat_messages')
    .insert({
      conversation_id: conversation.id,
      sender_user_id: safeUserId,
      message_type: 'text',
      body: safeMessage,
      is_request_message: false,
    })
    .select(
      'id, conversation_id, sender_user_id, message_type, body, is_request_message, edited_at, created_at'
    )
    .single()

  if (error) {
    throw databaseFailure(error, 'Failed to send message')
  }

  const readAt = new Date().toISOString()

  await supabase
    .from('chat_participants')
    .update({ last_read_at: readAt })
    .eq('id', participant.id)

  const sender = await getPublicUser(safeUserId)

  return {
    ...data,
    sender: sender
      ? {
          id: sender.id,
          name: sender.name,
          username: sender.username,
          avatar_url: sender.avatar_url || null,
        }
      : null,
    is_mine: true,
  }
}

export async function decideMessageRequest({
  userId,
  conversationId,
  action,
}) {
  const safeUserId = requireUuid(userId, 'User ID')
  const normalizedAction = cleanText(
    action,
    20
  ).toLowerCase()

  if (!['accept', 'decline', 'block'].includes(normalizedAction)) {
    fail(
      400,
      'INVALID_ACTION',
      'Request action is not valid'
    )
  }

  const {
    conversation,
    participant,
  } = await getConversationAccess(
    conversationId,
    safeUserId
  )

  const isRequestRecipient =
    String(conversation.created_by_user_id) !== safeUserId

  if (!isRequestRecipient) {
    fail(
      403,
      'REQUEST_RECIPIENT_REQUIRED',
      'Only the request recipient can manage this request'
    )
  }

  if (conversation.conversation_type === 'reader_author') {
    if (participant.participant_role !== 'author') {
      fail(
        403,
        'AUTHOR_DECISION_REQUIRED',
        'Only the author can manage this request'
      )
    }

    const authorPage = await getAuthorPage(
      conversation.author_page_id
    )

    if (String(authorPage.user_id) !== safeUserId) {
      fail(
        403,
        'AUTHOR_DECISION_REQUIRED',
        'Only the author page owner can manage this request'
      )
    }
  } else if (
    conversation.conversation_type === 'reader_reader'
  ) {
    if (participant.participant_role !== 'reader') {
      fail(
        403,
        'READER_DECISION_REQUIRED',
        'Only the reader recipient can manage this request'
      )
    }
  } else {
    fail(
      400,
      'INVALID_CONVERSATION_TYPE',
      'Conversation type is not supported'
    )
  }

  if (
    normalizedAction !== 'block' &&
    conversation.request_status !== 'pending'
  ) {
    if (
      normalizedAction === 'accept' &&
      conversation.request_status === 'accepted'
    ) {
      return buildConversationSummary(
        conversation,
        participant
      )
    }

    fail(
      409,
      'REQUEST_ALREADY_DECIDED',
      'This message request was already decided'
    )
  }

  const nextStatus =
    normalizedAction === 'accept'
      ? 'accepted'
      : normalizedAction === 'decline'
        ? 'declined'
        : 'blocked'

  if (normalizedAction === 'block') {
    const otherParticipant = await getOtherParticipant(
      conversation.id,
      safeUserId
    )

    if (!otherParticipant) {
      fail(
        409,
        'PARTICIPANT_MISSING',
        'The other participant is unavailable'
      )
    }

    const { error: blockError } = await supabase
      .from('chat_blocks')
      .insert({
        blocker_user_id: safeUserId,
        blocked_user_id: otherParticipant.user_id,
      })

    if (
      blockError &&
      blockError.code !== '23505'
    ) {
      throw databaseFailure(
        blockError,
        'Failed to block user'
      )
    }
  }

  const { data, error } = await supabase
    .from('chat_conversations')
    .update({
      request_status: nextStatus,
      request_decided_at: new Date().toISOString(),
    })
    .eq('id', conversation.id)
    .select(
      'id, conversation_type, direct_key, created_by_user_id, author_page_id, request_status, request_decided_at, last_message_at, created_at, updated_at'
    )
    .single()

  if (error) {
    throw databaseFailure(
      error,
      'Failed to update message request'
    )
  }

  return buildConversationSummary(data, participant)
}

export async function markConversationRead({
  userId,
  conversationId,
}) {
  const safeUserId = requireUuid(userId, 'User ID')
  const {
    conversation,
    participant,
  } = await getConversationAccess(
    conversationId,
    safeUserId
  )

  const lastReadAt = new Date().toISOString()

  const { error } = await supabase
    .from('chat_participants')
    .update({ last_read_at: lastReadAt })
    .eq('id', participant.id)

  if (error) {
    throw databaseFailure(
      error,
      'Failed to mark conversation as read'
    )
  }

  return {
    conversation_id: conversation.id,
    last_read_at: lastReadAt,
  }
}
