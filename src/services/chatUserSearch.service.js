import { supabase } from '../config/supabase.js'

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const MAX_SEARCH_TERMS = 12
const MAX_SCAN_LIMIT = 100

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
    .replace(/[^\p{L}\p{M}\p{N}._\-\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 50)
}

function normalizeCompareValue(value) {
  return normalizeSearchQuery(value)
    .toLocaleLowerCase()
}

function getSearchTerms(value) {
  const query = normalizeSearchQuery(value)

  if (!query) return []

  const normalized = query.toLocaleLowerCase()
  const compact = normalized.replace(/\s+/g, '')
  const candidates = [
    normalized,
    compact !== normalized ? compact : '',
    ...normalized.split(/\s+/),
  ]

  const seen = new Set()
  const terms = []

  for (const candidate of candidates) {
    const term = normalizeSearchQuery(candidate)
    const key = term.toLocaleLowerCase()

    if (!term || seen.has(key)) continue

    seen.add(key)
    terms.push(term)

    if (terms.length >= MAX_SEARCH_TERMS) {
      break
    }
  }

  return terms
}

function makeIlikeFilter(columns, query) {
  const terms = getSearchTerms(query)

  return terms
    .flatMap((term) =>
      columns.map(
        (column) =>
          `${column}.ilike.*${term}*`
      )
    )
    .join(',')
}

function getValueScore(value, query) {
  const text = normalizeCompareValue(value)
  const target = normalizeCompareValue(query)

  if (!text || !target) return 0

  const compactText = text.replace(/\s+/g, '')
  const compactTarget = target.replace(/\s+/g, '')

  if (text === target) return 1000
  if (compactText === compactTarget) return 900
  if (text.startsWith(target)) return 700
  if (compactText.startsWith(compactTarget)) return 650
  if (text.includes(target)) return 500
  if (compactText.includes(compactTarget)) return 450

  return 0
}

function getResultScore(result, query) {
  const values = [
    result.username,
    result.name,
    result.page_username,
    result.page_slug,
    result.page_name,
    result.owner_username,
    result.owner_name,
  ]
  const texts = values
    .map(normalizeCompareValue)
    .filter(Boolean)
  const compactTexts = texts.map((text) =>
    text.replace(/\s+/g, '')
  )
  const target = normalizeCompareValue(query)
  const terms = target
    .split(/\s+/)
    .filter(Boolean)

  let score = Math.max(
    0,
    ...values.map((value) =>
      getValueScore(value, target)
    )
  )
  let matchedTerms = 0

  for (const term of terms) {
    let best = 0

    for (let index = 0; index < texts.length; index += 1) {
      const text = texts[index]
      const compactText = compactTexts[index]

      if (text === term || compactText === term) {
        best = Math.max(best, 160)
      } else if (
        text.startsWith(term) ||
        compactText.startsWith(term)
      ) {
        best = Math.max(best, 110)
      } else if (
        text.includes(term) ||
        compactText.includes(term)
      ) {
        best = Math.max(best, 70)
      }
    }

    if (best > 0) {
      matchedTerms += 1
      score += best
    }
  }

  if (
    terms.length > 1 &&
    matchedTerms === terms.length
  ) {
    score += 300
  }

  if (result.result_type === 'author') {
    score += 5
  }

  return score
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
  const scanLimit = Math.min(
    MAX_SCAN_LIMIT,
    Math.max(safeLimit * 5, 40)
  )
  const userFilter = makeIlikeFilter(
    ['name', 'username'],
    safeQuery
  )
  const pageFilter = makeIlikeFilter(
    [
      'page_name',
      'page_username',
      'page_slug',
    ],
    safeQuery
  )

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
      .or(userFilter)
      .order('name', { ascending: true })
      .limit(scanLimit),
    supabase
      .from('author_pages')
      .select(
        'id, user_id, page_name, page_username, page_slug, avatar_url'
      )
      .eq('status', 'active')
      .neq('user_id', safeUserId)
      .or(pageFilter)
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
      String(block.blocker_user_id) ===
      safeUserId
        ? block.blocked_user_id
        : block.blocker_user_id

    if (otherUserId) {
      blockedUserIds.add(
        String(otherUserId)
      )
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
        !blockedUserIds.has(
          String(user.id)
        )
    )
    .map((user) => ({
      id: user.id,
      user_id: user.id,
      name:
        user.name || 'Shadow Reader',
      username: user.username || '',
      avatar_url:
        user.avatar_url || null,
      is_author:
        Boolean(user.is_author),
      result_type: 'reader',
    }))

  const authorResults = [
    ...pageMap.values(),
  ]
    .filter(
      (page) =>
        !blockedUserIds.has(
          String(page.user_id)
        )
    )
    .map((page) => {
      const owner = ownerMap.get(
        String(page.user_id)
      )

      return {
        id: page.id,
        author_page_id: page.id,
        user_id: page.user_id,
        name:
          page.page_name || 'Author',
        username:
          page.page_username ||
          page.page_slug ||
          '',
        page_name:
          page.page_name || 'Author',
        page_username:
          page.page_username || '',
        page_slug:
          page.page_slug || '',
        owner_name:
          owner?.name || '',
        owner_username:
          owner?.username || '',
        avatar_url:
          page.avatar_url || null,
        is_author: true,
        result_type: 'author',
      }
    })

  return [
    ...readerResults,
    ...authorResults,
  ]
    .map((result) => ({
      result,
      score: getResultScore(
        result,
        safeQuery
      ),
    }))
    .filter((item) => item.score > 0)
    .sort((first, second) => {
      if (
        second.score !== first.score
      ) {
        return (
          second.score - first.score
        )
      }

      return String(
        first.result.name || ''
      ).localeCompare(
        String(
          second.result.name || ''
        ),
        undefined,
        { sensitivity: 'base' }
      )
    })
    .slice(0, safeLimit)
    .map((item) => item.result)
}
