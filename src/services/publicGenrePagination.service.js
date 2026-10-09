export const GENRE_PAGE_SIZE = 9

function normalizeGenreSort(value) {
  const sort = String(value || 'latest').trim().toLowerCase()
  return ['updated', 'episode_updated'].includes(sort) ? 'updated' : 'latest'
}

function getGenreSortColumn(sort) {
  return normalizeGenreSort(sort) === 'updated' ? 'updated_at' : 'created_at'
}

function quoteFilterValue(value) {
  return `"${String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

export function decodeGenreCursor(value) {
  try {
    const parsed = JSON.parse(Buffer.from(String(value || ''), 'base64url').toString('utf8'))
    if (!parsed?.value || !parsed?.id) return null
    return { value: String(parsed.value), id: String(parsed.id) }
  } catch {
    return null
  }
}

export function applyGenrePaginationQuery(query, cursor, sort) {
  const column = getGenreSortColumn(sort)
  const parsed = decodeGenreCursor(cursor)

  if (parsed) {
    const value = quoteFilterValue(parsed.value)
    const id = quoteFilterValue(parsed.id)
    query = query.or(`${column}.lt.${value},and(${column}.eq.${value},id.lt.${id})`)
  }

  return query
    .order(column, { ascending: false })
    .order('id', { ascending: false })
    .limit(GENRE_PAGE_SIZE + 1)
}

export function finalizeGenrePage(rows, sort) {
  const items = Array.isArray(rows) ? rows : []
  const stories = items.slice(0, GENRE_PAGE_SIZE)
  const hasMore = items.length > GENRE_PAGE_SIZE
  const last = stories[stories.length - 1]
  const column = getGenreSortColumn(sort)
  const value = last?.[column]

  const nextCursor =
    hasMore && last?.id && value
      ? Buffer.from(
          JSON.stringify({
            value: String(value),
            id: String(last.id),
          })
        ).toString('base64url')
      : null

  return {
    stories,
    pagination: {
      limit: GENRE_PAGE_SIZE,
      has_more: hasMore,
      next_cursor: nextCursor,
    },
  }
}
