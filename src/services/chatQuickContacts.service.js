import { supabase } from '../config/supabase.js'
import { listMyConversations } from './chat.service.js'

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export class ChatQuickContactsError extends Error {
  constructor(status, code, message) {
    super(message)
    this.name = 'ChatQuickContactsError'
    this.status = status
    this.code = code
  }
}

function fail(status, code, message) {
  throw new ChatQuickContactsError(
    status,
    code,
    message
  )
}

function requireUserId(value) {
  const userId = String(value || '').trim()

  if (!UUID_PATTERN.test(userId)) {
    fail(
      401,
      'CHAT_QUICK_CONTACTS_UNAUTHORIZED',
      'Please log in to load contacts'
    )
  }

  return userId
}

function safeLimit(value) {
  return Math.min(
    12,
    Math.max(1, Number(value) || 12)
  )
}

function databaseFailure(error, message) {
  const wrapped = new ChatQuickContactsError(
    500,
    'CHAT_QUICK_CONTACTS_DATABASE_ERROR',
    message
  )

  wrapped.cause = error
  return wrapped
}

export async function touchChatPresence({
  userId,
}) {
  const safeUserId = requireUserId(userId)
  const now = new Date().toISOString()

  const { error } = await supabase
    .from('chat_presence')
    .upsert(
      {
        user_id: safeUserId,
        last_seen_at: now,
        updated_at: now,
      },
      {
        onConflict: 'user_id',
      }
    )

  if (error) {
    throw databaseFailure(
      error,
      'Failed to update online status'
    )
  }

  return {
    last_seen_at: now,
  }
}

export async function listChatQuickContacts({
  userId,
  limit,
}) {
  const safeUserId = requireUserId(userId)
  const resultLimit = safeLimit(limit)

  const [
    conversations,
    followingResult,
    followersResult,
    authorFollowsResult,
    blocksResult,
  ] = await Promise.all([
    listMyConversations({
      userId: safeUserId,
      status: 'accepted',
    }),
    supabase
      .from('user_follows')
      .select(
        'following_user_id, created_at'
      )
      .eq('follower_user_id', safeUserId)
      .limit(50),
    supabase
      .from('user_follows')
      .select(
        'follower_user_id, created_at'
      )
      .eq('following_user_id', safeUserId)
      .limit(50),
    supabase
      .from('author_page_follows')
      .select(
        'author_page_id, created_at'
      )
      .eq('follower_user_id', safeUserId)
      .limit(50),
    supabase
      .from('chat_blocks')
      .select(
        'blocker_user_id, blocked_user_id'
      )
      .or(
        `blocker_user_id.eq.${safeUserId},blocked_user_id.eq.${safeUserId}`
      ),
  ])

  for (const result of [
    followingResult,
    followersResult,
    authorFollowsResult,
    blocksResult,
  ]) {
    if (result.error) {
      throw databaseFailure(
        result.error,
        'Failed to load quick contacts'
      )
    }
  }

  const blockedUserIds = new Set()

  for (const block of blocksResult.data || []) {
    const otherUserId =
      String(block.blocker_user_id) ===
      safeUserId
        ? block.blocked_user_id
        : block.blocker_user_id

    if (otherUserId) {
      blockedUserIds.add(String(otherUserId))
    }
  }

  const followingIds = new Set(
    (followingResult.data || [])
      .map((row) => row.following_user_id)
      .filter(Boolean)
      .map(String)
  )
  const followerIds = new Set(
    (followersResult.data || [])
      .map((row) => row.follower_user_id)
      .filter(Boolean)
      .map(String)
  )
  const authorPageIds = [
    ...new Set(
      (authorFollowsResult.data || [])
        .map((row) => row.author_page_id)
        .filter(Boolean)
        .map(String)
    ),
  ]
  const readerIds = [
    ...new Set([
      ...followingIds,
      ...followerIds,
    ]),
  ].filter(
    (id) =>
      id !== safeUserId &&
      !blockedUserIds.has(id)
  )

  const [usersResult, authorPagesResult] =
    await Promise.all([
      readerIds.length
        ? supabase
            .from('users')
            .select(
              'id, name, username, avatar_url, is_author'
            )
            .in('id', readerIds)
            .eq('is_active', true)
        : Promise.resolve({
            data: [],
            error: null,
          }),
      authorPageIds.length
        ? supabase
            .from('author_pages')
            .select(
              'id, user_id, page_name, page_username, avatar_url'
            )
            .in('id', authorPageIds)
            .eq('status', 'active')
        : Promise.resolve({
            data: [],
            error: null,
          }),
    ])

  if (usersResult.error || authorPagesResult.error) {
    throw databaseFailure(
      usersResult.error ||
        authorPagesResult.error,
      'Failed to load contact profiles'
    )
  }

  const contacts = new Map()

  function addContact(contact) {
    if (
      !contact?.key ||
      !contact?.user_id ||
      blockedUserIds.has(
        String(contact.user_id)
      )
    ) {
      return
    }

    const current = contacts.get(contact.key)

    if (!current) {
      contacts.set(contact.key, contact)
      return
    }

    contacts.set(contact.key, {
      ...current,
      ...contact,
      is_following:
        current.is_following ||
        contact.is_following,
      is_follower:
        current.is_follower ||
        contact.is_follower,
      conversation_id:
        current.conversation_id ||
        contact.conversation_id ||
        null,
      last_interaction_at:
        current.last_interaction_at ||
        contact.last_interaction_at ||
        null,
    })
  }

  for (const conversation of conversations || []) {
    const person =
      conversation.counterpart || {}
    const authorPageId =
      person.author_page_id ||
      conversation.author_page_id ||
      null
    const contactType =
      authorPageId ||
      person.type === 'author'
        ? 'author'
        : 'reader'
    const userId =
      person.user_id || null

    addContact({
      key:
        contactType === 'author'
          ? `author:${authorPageId}`
          : `reader:${userId}`,
      type: contactType,
      user_id: userId,
      author_page_id:
        contactType === 'author'
          ? authorPageId
          : null,
      name:
        person.name ||
        person.page_name ||
        'Shadow User',
      username:
        person.username ||
        person.page_username ||
        '',
      avatar_url:
        person.avatar_url || null,
      is_following:
        userId
          ? followingIds.has(String(userId))
          : false,
      is_follower:
        userId
          ? followerIds.has(String(userId))
          : false,
      conversation_id:
        conversation.id,
      last_interaction_at:
        conversation.last_message_at ||
        conversation.latest_message
          ?.created_at ||
        conversation.updated_at ||
        null,
      source_priority: 3,
    })
  }

  for (const user of usersResult.data || []) {
    const userId = String(user.id)

    addContact({
      key: `reader:${userId}`,
      type: 'reader',
      user_id: user.id,
      author_page_id: null,
      name:
        user.name ||
        user.username ||
        'Shadow Reader',
      username: user.username || '',
      avatar_url:
        user.avatar_url || null,
      is_following:
        followingIds.has(userId),
      is_follower:
        followerIds.has(userId),
      conversation_id: null,
      last_interaction_at: null,
      source_priority:
        followingIds.has(userId) ? 2 : 1,
    })
  }

  for (
    const page of authorPagesResult.data || []
  ) {
    if (
      blockedUserIds.has(
        String(page.user_id)
      )
    ) {
      continue
    }

    addContact({
      key: `author:${page.id}`,
      type: 'author',
      user_id: page.user_id,
      author_page_id: page.id,
      name:
        page.page_name ||
        page.page_username ||
        'Author',
      username:
        page.page_username || '',
      avatar_url:
        page.avatar_url || null,
      is_following: true,
      is_follower: false,
      conversation_id: null,
      last_interaction_at: null,
      source_priority: 2,
    })
  }

  const contactList = [...contacts.values()]
  const presenceUserIds = [
    ...new Set(
      contactList
        .map((contact) => contact.user_id)
        .filter(Boolean)
        .map(String)
    ),
  ]
  const onlineCutoff = new Date(
    Date.now() - 2 * 60 * 1000
  ).toISOString()
  const presenceResult =
    presenceUserIds.length
      ? await supabase
          .from('chat_presence')
          .select('user_id, last_seen_at')
          .in('user_id', presenceUserIds)
          .gte('last_seen_at', onlineCutoff)
      : {
          data: [],
          error: null,
        }

  if (presenceResult.error) {
    throw databaseFailure(
      presenceResult.error,
      'Failed to load online status'
    )
  }

  const onlineUserIds = new Set(
    (presenceResult.data || [])
      .map((row) => row.user_id)
      .filter(Boolean)
      .map(String)
  )

  return contactList
    .map((contact) => ({
      ...contact,
      is_online:
        onlineUserIds.has(
          String(contact.user_id)
        ),
    }))
    .sort((first, second) => {
      if (
  second.is_online !== first.is_online
) {
  return second.is_online ? 1 : -1
}

if (
  Boolean(second.conversation_id) !==
  Boolean(first.conversation_id)
) {
  return second.conversation_id ? 1 : -1
}

      if (
        second.source_priority !==
        first.source_priority
      ) {
        return (
          second.source_priority -
          first.source_priority
        )
      }

      const firstTime = new Date(
        first.last_interaction_at || 0
      ).getTime()
      const secondTime = new Date(
        second.last_interaction_at || 0
      ).getTime()

      if (secondTime !== firstTime) {
        return secondTime - firstTime
      }

      return String(
        first.name || ''
      ).localeCompare(
        String(second.name || ''),
        undefined,
        {
          sensitivity: 'base',
        }
      )
    })
    .slice(0, resultLimit)
    .map(
      ({
        source_priority,
        ...contact
      }) => contact
    )
}
