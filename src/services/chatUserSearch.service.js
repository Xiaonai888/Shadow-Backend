import { supabase } from '../config/supabase.js'

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export class ChatUserSearchError extends Error {
  constructor(status, code, message) {
    super(message)
    this.name = 'ChatUserSearchError'
    this.status = status
    this.code = code
  }
}

function fail(status, code, message) {
  throw new ChatUserSearchError(
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
      'CHAT_SEARCH_UNAUTHORIZED',
      'Please log in to search people'
    )
  }

  return userId
}

function normalizeSearchQuery(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}._\-\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 50)
}

export async function searchChatUsers({
  userId,
  query,
  limit,
}) {
  const safeUserId = requireUserId(userId)
  const safeQuery = normalizeSearchQuery(query)

  if (safeQuery.length < 2) {
    fail(
      400,
      'CHAT_SEARCH_TOO_SHORT',
      'Enter at least 2 characters'
    )
  }

  const safeLimit = Math.min(
    20,
    Math.max(1, Number(limit) || 12)
  )
  const pattern = `%${safeQuery}%`

  const [
    { data: users, error: usersError },
    { data: blocks, error: blocksError },
  ] = await Promise.all([
    supabase
      .from('users')
      .select(
        'id, name, username, avatar_url, is_author'
      )
      .eq('is_active', true)
      .neq('id', safeUserId)
      .or(
        `name.ilike.${pattern},username.ilike.${pattern}`
      )
      .order('name', { ascending: true })
      .limit(safeLimit),
    supabase
      .from('chat_blocks')
      .select(
        'blocker_user_id, blocked_user_id'
      )
      .or(
        `blocker_user_id.eq.${safeUserId},blocked_user_id.eq.${safeUserId}`
      ),
  ])

  if (usersError || blocksError) {
    const error = new ChatUserSearchError(
      500,
      'CHAT_SEARCH_DATABASE_ERROR',
      'Failed to search people'
    )

    error.cause = usersError || blocksError
    throw error
  }

  const blockedUserIds = new Set()

  for (const block of blocks || []) {
    const otherUserId =
      String(block.blocker_user_id) ===
      safeUserId
        ? block.blocked_user_id
        : block.blocker_user_id

    if (otherUserId) {
      blockedUserIds.add(String(otherUserId))
    }
  }

  return (users || [])
    .filter(
      (user) =>
        !blockedUserIds.has(String(user.id))
    )
    .map((user) => ({
      id: user.id,
      name: user.name || 'Shadow Reader',
      username: user.username || '',
      avatar_url: user.avatar_url || null,
      is_author: Boolean(user.is_author),
    }))
}
