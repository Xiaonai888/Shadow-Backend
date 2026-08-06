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
  throw new ChatUserSearchError(status, code, message)
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
    .replace(/^@+/, '')
    .replace(/[^\p{L}\p{N}._\-\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 50)
}

function normalizeCompareValue(value) {
  return String(value || '')
    .normalize('NFKC')
    .trim()
    .replace(/^@+/, '')
    .toLowerCase()
}

function getValueRank(value, query) {
  const normalized = normalizeCompareValue(value)

  if (!normalized) return 20
  if (normalized === query) return 0
  if (normalized.startsWith(query)) return 2
  if (normalized.includes(query)) return 4

  return 20
}

function getResultRank(result, query) {
  const values = [
    result.username,
    result.name,
    result.page_username,
    result.page_slug,
    result.page_name,
    result.owner_username,
    result.owner_name,
  ]

  return Math.min(
    ...values.map((value) => getValueRank(value, query))
  )
}

function throwDatabaseError(error) {
  const wrapped = new ChatUserSearchError(
    500,
    'CHAT_SEARCH_DATABASE_ERROR',
    'Failed to search people'
  )

  wrapped.cause = error
  throw wrapped
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
  const scanLimit = Math.min(80, safeLimit * 4)
  const pattern = `%${safeQuery}%`

  const [
    usersResult,
    pagesResult,
    blocksResult,
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
      .limit(scanLimit),
    supabase
      .from('author_pages')
      .select(
        'id, user_id, page_name, page_username, page_slug, avatar_url'
      )
      .eq('status', 'active')
      .neq('user_id', safeUserId)
      .or(
        `page_name.ilike.${pattern},page_username.ilike.${pattern},page_slug.ilike.${pattern}`
      )
      .order('page_name', { ascending: true })
      .limit(scanLimit),
    supabase
      .from('chat_blocks')
      .select(
        'blocker_user_id, blocked_user_id'
      )
      .or(
        `blocker_user_id.eq.${safeUserId},blocked_user_id.eq.${safeUserId}`
      ),
  ])

  if (usersResult.error) {
    throwDatabaseError(usersResult.error)
  }

  if (pagesResult.error) {
    throwDatabaseError(pagesResult.error)
  }

  if (blocksResult.error) {
    throwDatabaseError(blocksResult.error)
  }

  const matchedUsers = usersResult.data || []
  const ownerUserIds = [
    ...new Set(
      matchedUsers
        .map((user) => user.id)
        .filter(Boolean)
    ),
  ]

  let ownerPages = []

  if (ownerUserIds.length) {
    const ownerPagesResult = await supabase
      .from('author_pages')
      .select(
        'id, user_id, page_name, page_username, page_slug, avatar_url'
      )
      .eq('status', 'active')
      .neq('user_id', safeUserId)
      .in('user_id', ownerUserIds)
      .limit(scanLimit)

    if (ownerPagesResult.error) {
      throwDatabaseError(ownerPagesResult.error)
    }

    ownerPages = ownerPagesResult.data || []
  }

  const blockedUserIds = new Set()

  for (const block of blocksResult.data || []) {
    const otherUserId =
      String(block.blocker_user_id) === safeUserId
        ? block.blocked_user_id
        : block.blocker_user_id

    if (otherUserId) {
      blockedUserIds.add(String(otherUserId))
    }
  }

  const ownerMap = new Map(
    matchedUsers.map((user) => [
      String(user.id),
      user,
    ])
  )

  const pageMap = new Map()

  for (const page of [
    ...(pagesResult.data || []),
    ...ownerPages,
  ]) {
    if (!page?.id) continue
    pageMap.set(String(page.id), page)
  }

  const readerResults = matchedUsers
    .filter(
      (user) =>
        !blockedUserIds.has(String(user.id))
    )
    .map((user) => ({
      id: user.id,
      user_id: user.id,
      name: user.name || 'Shadow Reader',
      username: user.username || '',
      avatar_url: user.avatar_url || null,
      is_author: Boolean(user.is_author),
      result_type: 'reader',
    }))

  const authorResults = [...pageMap.values()]
    .filter(
      (page) =>
        !blockedUserIds.has(String(page.user_id))
    )
    .map((page) => {
      const owner = ownerMap.get(String(page.user_id))

      return {
        id: page.id,
        author_page_id: page.id,
        user_id: page.user_id,
        name: page.page_name || 'Author',
        username:
          page.page_username ||
          page.page_slug ||
          '',
        page_name: page.page_name || 'Author',
        page_username:
          page.page_username || '',
        page_slug: page.page_slug || '',
        owner_name: owner?.name || '',
        owner_username: owner?.username || '',
        avatar_url: page.avatar_url || null,
        is_author: true,
        result_type: 'author',
      }
    })

  const normalizedQuery =
    normalizeCompareValue(safeQuery)

  return [
    ...readerResults,
    ...authorResults,
  ]
    .sort((first, second) => {
      const rankDifference =
        getResultRank(first, normalizedQuery) -
        getResultRank(second, normalizedQuery)

      if (rankDifference !== 0) {
        return rankDifference
      }

      if (
        first.result_type !== second.result_type
      ) {
        return first.result_type === 'author'
          ? -1
          : 1
      }

      return String(first.name || '').localeCompare(
        String(second.name || ''),
        undefined,
        { sensitivity: 'base' }
      )
    })
    .slice(0, safeLimit)
}
