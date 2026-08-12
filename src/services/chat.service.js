import { supabase } from '../config/supabase.js'
import {
  deleteR2ObjectByUrl,
  uploadFileToR2,
} from './r2Storage.service.js'

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const REQUEST_STATUSES = [
  'pending',
  'accepted',
  'declined',
  'blocked',
]

const CHAT_MESSAGE_FIELDS =
  'id, conversation_id, sender_user_id, message_type, body, is_request_message, reply_to_message_id, forwarded_from_message_id, forwarded_from_user_id, attachment_url, attachment_name, attachment_mime, attachment_size, attachment_kind, edited_at, deleted_at, created_at'

const CHAT_FILE_MIMES = new Set([
  'application/pdf',
  'text/plain',
  'application/zip',
  'application/x-zip-compressed',
  'application/epub+zip',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
])

const CHAT_FILE_EXTENSIONS = new Set([
  'pdf',
  'txt',
  'zip',
  'epub',
  'doc',
  'docx',
  'xls',
  'xlsx',
  'ppt',
  'pptx',
])

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

function requireChatAttachment(file) {
  if (!file?.buffer?.length) {
    fail(400, 'CHAT_ATTACHMENT_REQUIRED', 'Choose a file to send')
  }

  const mime = String(
    file.mimetype || 'application/octet-stream'
  ).toLowerCase()

  const originalName = String(
    file.originalname || 'file'
  )

  const extension = originalName.includes('.')
    ? originalName
        .split('.')
        .pop()
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '')
    : ''

  const imageAllowed =
    mime.startsWith('image/') &&
    ['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif'].includes(extension)

  const videoAllowed =
    mime.startsWith('video/') &&
    ['mp4', 'webm', 'mov'].includes(extension)

  const fileAllowed =
    CHAT_FILE_EXTENSIONS.has(extension) &&
    (
      CHAT_FILE_MIMES.has(mime) ||
      mime === 'application/octet-stream'
    )

  if (!imageAllowed && !videoAllowed && !fileAllowed) {
    fail(
      400,
      'CHAT_ATTACHMENT_TYPE_NOT_ALLOWED',
      'This file type is not supported'
    )
  }

  return {
    kind: imageAllowed
      ? 'image'
      : videoAllowed
        ? 'video'
        : 'file',
    name: originalName
      .replace(/[\u0000-\u001f\u007f/\\]/g, '_')
      .slice(0, 180),
    mime,
    size: Number(
      file.size || file.buffer.length || 0
    ),
  }
}

function getR2KeyFromUrl(value) {
  const publicUrl = String(
    process.env.R2_PUBLIC_URL || ''
  ).replace(/\/+$/, '')

  const url = String(value || '')

  if (
    !publicUrl ||
    !url.startsWith(`${publicUrl}/`)
  ) {
    return null
  }

  return decodeURIComponent(
    url
      .slice(publicUrl.length + 1)
      .split('?')[0]
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
      'id, conversation_type, direct_key, created_by_user_id, author_page_id, request_status, request_decided_at, last_message_at, cleared_for_all_at, is_group, group_name, group_avatar_url, created_at, updated_at'
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
      'id, conversation_id, user_id, participant_role, last_read_at, muted_at, archived_at, deleted_at, cleared_at, created_at'
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
      'id, conversation_id, user_id, participant_role, last_read_at, muted_at, archived_at, deleted_at, cleared_at, created_at'
    )
    .eq('conversation_id', conversationId)
    .neq('user_id', userId)
    .limit(1)
    .maybeSingle()

  if (error) {
    throw databaseFailure(error, 'Failed to load chat participant')
  }

  return data || null
}

async function getConversationParticipantCount(
  conversationId
) {
  const { count, error } = await supabase
    .from('chat_participants')
    .select('id', {
      count: 'exact',
      head: true,
    })
    .eq('conversation_id', conversationId)

  if (error) {
    throw databaseFailure(
      error,
      'Failed to count group members'
    )
  }

  return Number(count || 0)
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

function getVisibilityCutoff(
  conversation,
  participant
) {
  const values = [
    conversation?.cleared_for_all_at,
    participant?.cleared_at,
  ]
    .filter(Boolean)
    .map((value) => new Date(value))
    .filter(
      (value) =>
        !Number.isNaN(value.getTime())
    )

  if (!values.length) {
    return null
  }

  return new Date(
    Math.max(
      ...values.map((value) =>
        value.getTime()
      )
    )
  ).toISOString()
}

function formatDeletedMessage(message) {
  const isDeleted = Boolean(
    message?.deleted_at
  )

  return {
    ...message,
    body: isDeleted
      ? ''
      : message?.body || '',
    attachment_url: isDeleted
      ? null
      : message?.attachment_url || null,
    attachment_name: isDeleted
      ? null
      : message?.attachment_name || null,
    attachment_mime: isDeleted
      ? null
      : message?.attachment_mime || null,
    attachment_size: isDeleted
      ? null
      : message?.attachment_size || null,
    attachment_kind: isDeleted
      ? null
      : message?.attachment_kind || null,
    is_deleted: isDeleted,
  }
}

async function getLatestMessage(
  conversation,
  viewerParticipant
) {
  let query = supabase
    .from('chat_messages')
    .select(
      CHAT_MESSAGE_FIELDS
    )
    .eq(
      'conversation_id',
      conversation.id
    )
    .order('created_at', {
      ascending: false,
    })
    .limit(1)

  const visibilityCutoff =
    getVisibilityCutoff(
      conversation,
      viewerParticipant
    )

  if (visibilityCutoff) {
    query = query.gt(
      'created_at',
      visibilityCutoff
    )
  }

  const { data, error } =
    await query.maybeSingle()

  if (error) {
    throw databaseFailure(
      error,
      'Failed to load latest message'
    )
  }

  return data
    ? formatDeletedMessage(data)
    : null
}

async function getUnreadCount(
  conversation,
  viewerParticipant
) {
  let query = supabase
    .from('chat_messages')
    .select('id', {
      count: 'exact',
      head: true,
    })
    .eq(
      'conversation_id',
      conversation.id
    )
    .neq(
      'sender_user_id',
      viewerParticipant.user_id
    )
    .is('deleted_at', null)

  const readCutoffs = [
    viewerParticipant.last_read_at,
    getVisibilityCutoff(
      conversation,
      viewerParticipant
    ),
  ]
    .filter(Boolean)
    .map((value) => new Date(value))
    .filter(
      (value) =>
        !Number.isNaN(value.getTime())
    )

  if (readCutoffs.length) {
    query = query.gt(
      'created_at',
      new Date(
        Math.max(
          ...readCutoffs.map((value) =>
            value.getTime()
          )
        )
      ).toISOString()
    )
  }

  const { count, error } = await query

  if (error) {
    throw databaseFailure(
      error,
      'Failed to count unread messages'
    )
  }

  return Number(count || 0)
}

async function buildConversationSummary(
  conversation,
  viewerParticipant
) {
  const isGroup =
    conversation.is_group === true

  const [
    otherParticipant,
    authorPage,
    latestMessage,
    unreadCount,
    memberCount,
  ] = await Promise.all([
    isGroup
      ? Promise.resolve(null)
      : getOtherParticipant(
          conversation.id,
          viewerParticipant.user_id
        ),
    !isGroup && conversation.author_page_id
      ? getAuthorPage(
          conversation.author_page_id
        )
      : Promise.resolve(null),
    getLatestMessage(
      conversation,
      viewerParticipant
    ),
    getUnreadCount(
      conversation,
      viewerParticipant
    ),
    isGroup
      ? getConversationParticipantCount(
          conversation.id
        )
      : Promise.resolve(2),
  ])

  const otherUser = isGroup
    ? null
    : await getPublicUser(
        otherParticipant?.user_id
      )

  const counterpart = isGroup
    ? {
        type: 'group',
        user_id: null,
        author_page_id: null,
        name:
          conversation.group_name ||
          'Group chat',
        username: '',
        avatar_url:
          conversation.group_avatar_url ||
          null,
        member_count: memberCount,
      }
    : viewerParticipant.participant_role ===
          'reader' && authorPage
      ? {
          type: 'author',
          user_id: authorPage.user_id,
          author_page_id: authorPage.id,
          name: authorPage.page_name,
          username:
            authorPage.page_username,
          avatar_url:
            authorPage.avatar_url || null,
        }
      : {
          type:
            otherParticipant?.participant_role ||
            'reader',
          user_id:
            otherUser?.id ||
            otherParticipant?.user_id ||
            null,
          author_page_id: null,
          name:
            otherUser?.name ||
            'Shadow Reader',
          username:
            otherUser?.username || '',
          avatar_url:
            otherUser?.avatar_url || null,
        }

  return {
    id: conversation.id,
    conversation_type:
      conversation.conversation_type,
    is_group: isGroup,
    group_name:
      isGroup
        ? conversation.group_name || ''
        : '',
    group_avatar_url:
      isGroup
        ? conversation.group_avatar_url ||
          null
        : null,
    member_count:
      isGroup ? memberCount : 2,
    request_status:
      conversation.request_status,
    viewer_role:
      viewerParticipant.participant_role,
    created_by_user_id:
      conversation.created_by_user_id,
    author_page_id:
      conversation.author_page_id,
    counterpart,
    latest_message: latestMessage,
    unread_count: unreadCount,
    can_send:
      conversation.request_status ===
      'accepted',
    can_decide:
      !isGroup &&
      conversation.request_status ===
        'pending' &&
      String(
        conversation.created_by_user_id
      ) !==
        String(viewerParticipant.user_id),
    last_read_at:
      viewerParticipant.last_read_at,
    cleared_at:
      viewerParticipant.cleared_at || null,
    cleared_for_all_at:
      conversation.cleared_for_all_at ||
      null,
    last_message_at:
      conversation.last_message_at,
    created_at: conversation.created_at,
    updated_at: conversation.updated_at,
  }
}

async function getConversationSummaryForUser(
  conversationId,
  userId
) {
  const safeConversationId = requireUuid(
    conversationId,
    'Conversation ID'
  )
  const safeUserId = requireUuid(
    userId,
    'User ID'
  )

  const { error: restoreError } =
    await supabase
      .from('chat_participants')
      .update({
        archived_at: null,
        deleted_at: null,
      })
      .eq(
        'conversation_id',
        safeConversationId
      )
      .eq('user_id', safeUserId)

  if (restoreError) {
    throw databaseFailure(
      restoreError,
      'Failed to restore conversation'
    )
  }

  const { conversation, participant } =
    await getConversationAccess(
      safeConversationId,
      safeUserId
    )

  return buildConversationSummary(
    conversation,
    participant
  )
}

async function getExistingDirectConversation(directKey) {
  const { data, error } = await supabase
    .from('chat_conversations')
    .select(
      'id, conversation_type, direct_key, created_by_user_id, author_page_id, request_status, request_decided_at, last_message_at, cleared_for_all_at, created_at, updated_at'
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
    if (existing.request_status === 'blocked') {
      fail(403, 'CHAT_BLOCKED', 'Messaging is blocked')
    }

    if (existing.request_status !== 'accepted') {
      const { error: acceptError } = await supabase
        .from('chat_conversations')
        .update({
          request_status: 'accepted',
          request_decided_at: new Date().toISOString(),
        })
        .eq('id', existing.id)

      if (acceptError) {
        throw databaseFailure(
          acceptError,
          'Failed to open author conversation'
        )
      }
    }

    const { error: messageError } = await supabase
      .from('chat_messages')
      .insert({
        conversation_id: existing.id,
        sender_user_id: safeReaderUserId,
        message_type: 'text',
        body: safeMessage,
        is_request_message: false,
      })

    if (messageError) {
      throw databaseFailure(
        messageError,
        'Failed to send author message'
      )
    }

    return {
      created: false,
      conversation:
        await getConversationSummaryForUser(
          existing.id,
          safeReaderUserId
        ),
    }
  }

  const now = new Date().toISOString()

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
      request_status: 'accepted',
      request_decided_at: now,
    })
    .select(
      'id, conversation_type, direct_key, created_by_user_id, author_page_id, request_status, request_decided_at, last_message_at, cleared_for_all_at, created_at, updated_at'
    )
    .single()

  if (conversationError) {
    if (conversationError.code === '23505') {
      const racedConversation =
        await getExistingDirectConversation(directKey)

      if (racedConversation) {
        if (racedConversation.request_status === 'blocked') {
          fail(403, 'CHAT_BLOCKED', 'Messaging is blocked')
        }

        if (racedConversation.request_status !== 'accepted') {
          const { error: acceptError } = await supabase
            .from('chat_conversations')
            .update({
              request_status: 'accepted',
              request_decided_at: now,
            })
            .eq('id', racedConversation.id)

          if (acceptError) {
            throw databaseFailure(
              acceptError,
              'Failed to open author conversation'
            )
          }
        }

        const { error: messageError } = await supabase
          .from('chat_messages')
          .insert({
            conversation_id: racedConversation.id,
            sender_user_id: safeReaderUserId,
            message_type: 'text',
            body: safeMessage,
            is_request_message: false,
          })

        if (messageError) {
          throw databaseFailure(
            messageError,
            'Failed to send author message'
          )
        }

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
      'Failed to create author conversation'
    )
  }

  try {
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
        is_request_message: false,
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
      'Failed to save author conversation'
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
      'id, conversation_type, direct_key, created_by_user_id, author_page_id, request_status, request_decided_at, last_message_at, cleared_for_all_at, created_at, updated_at'
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

export async function createGroupConversation({
  creatorUserId,
  memberUserIds,
  name,
}) {
  const safeCreatorUserId = requireUuid(
    creatorUserId,
    'Creator user ID'
  )
  const safeName = cleanText(name, 60)

  if (!safeName) {
    fail(
      400,
      'GROUP_NAME_REQUIRED',
      'Group name is required'
    )
  }

  if (!Array.isArray(memberUserIds)) {
    fail(
      400,
      'GROUP_MEMBERS_REQUIRED',
      'Choose people for the group'
    )
  }

  const uniqueMemberIds = [
    ...new Set(
      memberUserIds
        .map((value) =>
          requireUuid(
            value,
            'Group member user ID'
          )
        )
        .filter(
          (value) =>
            value !== safeCreatorUserId
        )
    ),
  ]

  if (uniqueMemberIds.length < 2) {
    fail(
      400,
      'GROUP_MIN_MEMBERS',
      'Choose at least 2 people'
    )
  }

  if (uniqueMemberIds.length > 49) {
    fail(
      400,
      'GROUP_MAX_MEMBERS',
      'A group can have up to 50 people'
    )
  }

  const members = await Promise.all(
    uniqueMemberIds.map((userId) =>
      getActiveUser(userId)
    )
  )

  const blocks = await Promise.all(
    members.map((member) =>
      findBlockBetween(
        safeCreatorUserId,
        member.id
      )
    )
  )

  if (blocks.some(Boolean)) {
    fail(
      403,
      'GROUP_MEMBER_BLOCKED',
      'A blocked account cannot be added to this group'
    )
  }

  const now = new Date().toISOString()
  const directKey =
    `group:${safeCreatorUserId}:${Date.now()}:${Math.random()
      .toString(36)
      .slice(2, 10)}`

  const {
    data: conversation,
    error: conversationError,
  } = await supabase
    .from('chat_conversations')
    .insert({
      conversation_type: 'reader_reader',
      direct_key: directKey,
      created_by_user_id:
        safeCreatorUserId,
      author_page_id: null,
      request_status: 'accepted',
      request_decided_at: now,
      is_group: true,
      group_name: safeName,
      group_avatar_url: null,
    })
    .select(
      'id, conversation_type, direct_key, created_by_user_id, author_page_id, request_status, request_decided_at, last_message_at, cleared_for_all_at, is_group, group_name, group_avatar_url, created_at, updated_at'
    )
    .single()

  if (conversationError) {
    throw databaseFailure(
      conversationError,
      'Failed to create group chat'
    )
  }

  try {
    const participantRows = [
      {
        conversation_id: conversation.id,
        user_id: safeCreatorUserId,
        participant_role: 'reader',
        last_read_at: now,
      },
      ...members.map((member) => ({
        conversation_id: conversation.id,
        user_id: member.id,
        participant_role: 'reader',
      })),
    ]

    const { error: participantsError } =
      await supabase
        .from('chat_participants')
        .insert(participantRows)

    if (participantsError) {
      throw participantsError
    }
  } catch (error) {
    await supabase
      .from('chat_conversations')
      .delete()
      .eq('id', conversation.id)

    throw databaseFailure(
      error,
      'Failed to save group members'
    )
  }

  return {
    created: true,
    conversation: {
      ...conversation,
      member_count:
        uniqueMemberIds.length + 1,
    },
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
        'id, conversation_id, user_id, participant_role, last_read_at, muted_at, archived_at, deleted_at, cleared_at, created_at'
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
      'id, conversation_type, direct_key, created_by_user_id, author_page_id, request_status, request_decided_at, last_message_at, cleared_for_all_at, is_group, group_name, group_avatar_url, created_at, updated_at'
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
  const safeUserId = requireUuid(
    userId,
    'User ID'
  )
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
  const visibilityCutoff =
    getVisibilityCutoff(
      conversation,
      participant
    )

  let messageQuery = supabase
    .from('chat_messages')
    .select(
      CHAT_MESSAGE_FIELDS
    )
    .eq(
      'conversation_id',
      conversation.id
    )
    .order('created_at', {
      ascending: false,
    })
    .limit(safeLimit)

  if (visibilityCutoff) {
    messageQuery = messageQuery.gt(
      'created_at',
      visibilityCutoff
    )
  }

  if (before) {
    const beforeDate = new Date(before)

    if (
      Number.isNaN(
        beforeDate.getTime()
      )
    ) {
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

  const {
    data: messageRows,
    error: messageError,
  } = await messageQuery

  if (messageError) {
    throw databaseFailure(
      messageError,
      'Failed to load messages'
    )
  }

  const messages = [
    ...(messageRows || []),
  ].reverse()
  const replyMessageIds = [
    ...new Set(
      messages
        .map(
          (item) =>
            item.reply_to_message_id
        )
        .filter(Boolean)
    ),
  ]
  let replyMap = new Map()

  if (replyMessageIds.length) {
    const {
      data: replyRows,
      error: replyError,
    } = await supabase
      .from('chat_messages')
      .select(
        CHAT_MESSAGE_FIELDS
      )
      .eq(
        'conversation_id',
        conversation.id
      )
      .in('id', replyMessageIds)

    if (replyError) {
      throw databaseFailure(
        replyError,
        'Failed to load replied messages'
      )
    }

    replyMap = new Map(
      (replyRows || []).map((item) => [
        String(item.id),
        item,
      ])
    )
  }

  const senderIds = [
    ...new Set(
      [
        ...messages.map(
          (item) =>
            item.sender_user_id
        ),
        ...messages.map(
          (item) =>
            item.forwarded_from_user_id
        ),
        ...Array.from(
          replyMap.values()
        ).map(
          (item) =>
            item.sender_user_id
        ),
      ].filter(Boolean)
    ),
  ]
  let senderMap = new Map()

  if (senderIds.length) {
    const {
      data: senders,
      error: senderError,
    } = await supabase
      .from('users')
      .select(
        'id, name, username, avatar_url'
      )
      .in('id', senderIds)

    if (senderError) {
      throw databaseFailure(
        senderError,
        'Failed to load message senders'
      )
    }

    senderMap = new Map(
      (senders || []).map((item) => [
        String(item.id),
        item,
      ])
    )
  }

  const formatUser = (userId) => {
    const user = senderMap.get(
      String(userId || '')
    )

    return user
      ? {
          id: user.id,
          name: user.name,
          username: user.username,
          avatar_url:
            user.avatar_url || null,
        }
      : null
  }

  const formattedMessages =
    messages.map((item) => {
      const formatted =
        formatDeletedMessage(item)
      const original = item.reply_to_message_id
        ? replyMap.get(
            String(
              item.reply_to_message_id
            )
          )
        : null
      const originalIsVisible =
        original &&
        (!visibilityCutoff ||
          new Date(
            original.created_at
          ).getTime() >
            new Date(
              visibilityCutoff
            ).getTime())
      const replyTo =
        item.reply_to_message_id
          ? originalIsVisible
            ? {
                ...formatDeletedMessage(
                  original
                ),
                sender: formatUser(
                  original.sender_user_id
                ),
              }
            : {
                id:
                  item.reply_to_message_id,
                body: '',
                is_deleted: true,
                is_unavailable: true,
                sender: null,
              }
          : null

      return {
        ...formatted,
        sender: formatUser(
          item.sender_user_id
        ),
        is_mine:
          String(
            item.sender_user_id
          ) === safeUserId,
        reply_to: replyTo,
        is_forwarded: Boolean(
          item.forwarded_from_message_id
        ),
        forwarded_from: item
          .forwarded_from_user_id
          ? formatUser(
              item.forwarded_from_user_id
            )
          : null,
      }
    })

  return {
    conversation:
      await buildConversationSummary(
        conversation,
        participant
      ),
    messages: formattedMessages,
    selection_limit: 100,
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

  const isGroup =
    conversation.is_group === true
  let otherParticipant = null

  if (isGroup) {
    const memberCount =
      await getConversationParticipantCount(
        conversation.id
      )

    if (memberCount < 2) {
      fail(
        409,
        'PARTICIPANT_MISSING',
        'Group participants are unavailable'
      )
    }
  } else {
    otherParticipant =
      await getOtherParticipant(
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
      fail(
        403,
        'CHAT_BLOCKED',
        'Messaging is blocked'
      )
    }
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
      CHAT_MESSAGE_FIELDS
    )
    .single()

  if (error) {
    throw databaseFailure(
      error,
      'Failed to send message'
    )
  }

  const { error: restoreError } =
    await supabase
      .from('chat_participants')
      .update({
        archived_at: null,
        deleted_at: null,
      })
      .eq(
        'conversation_id',
        conversation.id
      )
      .neq('user_id', safeUserId)

  if (restoreError) {
    throw databaseFailure(
      restoreError,
      'Failed to restore recipient conversation'
    )
  }

  const readAt = new Date().toISOString()

  await supabase
    .from('chat_participants')
    .update({
      last_read_at: readAt,
      archived_at: null,
      deleted_at: null,
    })
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

export async function sendConversationAttachment({
  userId,
  conversationId,
  message,
  file,
}) {
  const safeUserId = requireUuid(
    userId,
    'User ID'
  )
  const safeMessage = cleanText(message, 2000)
  const attachment =
    requireChatAttachment(file)

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
    fail(
      403,
      'CHAT_BLOCKED',
      'Messaging is blocked'
    )
  }

  const isGroup =
    conversation.is_group === true
  let otherParticipant = null

  if (isGroup) {
    const memberCount =
      await getConversationParticipantCount(
        conversation.id
      )

    if (memberCount < 2) {
      fail(
        409,
        'PARTICIPANT_MISSING',
        'Group participants are unavailable'
      )
    }
  } else {
    otherParticipant =
      await getOtherParticipant(
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
      fail(
        403,
        'CHAT_BLOCKED',
        'Messaging is blocked'
      )
    }
  }

  let attachmentUrl = ''

  try {
    attachmentUrl = await uploadFileToR2(
      file,
      'chat-attachments'
    )
  } catch (error) {
    const wrapped = new ChatServiceError(
      500,
      'CHAT_ATTACHMENT_UPLOAD_FAILED',
      'Failed to upload attachment'
    )

    wrapped.cause = error
    throw wrapped
  }

  const { data, error } = await supabase
    .from('chat_messages')
    .insert({
      conversation_id: conversation.id,
      sender_user_id: safeUserId,
      message_type: 'text',
      body: safeMessage,
      is_request_message: false,
      attachment_url: attachmentUrl,
      attachment_r2_key:
        getR2KeyFromUrl(attachmentUrl),
      attachment_name: attachment.name,
      attachment_mime: attachment.mime,
      attachment_size: attachment.size,
      attachment_kind: attachment.kind,
    })
    .select(CHAT_MESSAGE_FIELDS)
    .single()

  if (error) {
    await deleteR2ObjectByUrl(
      attachmentUrl
    ).catch(() => {})

    throw databaseFailure(
      error,
      'Failed to send attachment'
    )
  }

  const { error: restoreError } =
    await supabase
      .from('chat_participants')
      .update({
        archived_at: null,
        deleted_at: null,
      })
      .eq(
        'conversation_id',
        conversation.id
      )
      .neq('user_id', safeUserId)

  if (restoreError) {
    throw databaseFailure(
      restoreError,
      'Failed to restore recipient conversation'
    )
  }

  const readAt = new Date().toISOString()

  await supabase
    .from('chat_participants')
    .update({
      last_read_at: readAt,
      archived_at: null,
      deleted_at: null,
    })
    .eq('id', participant.id)

  const sender = await getPublicUser(
    safeUserId
  )

  return {
    ...data,
    sender: sender
      ? {
          id: sender.id,
          name: sender.name,
          username: sender.username,
          avatar_url:
            sender.avatar_url || null,
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
      'id, conversation_type, direct_key, created_by_user_id, author_page_id, request_status, request_decided_at, last_message_at, cleared_for_all_at, created_at, updated_at'
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
