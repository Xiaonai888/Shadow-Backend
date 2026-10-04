export const GENRE_PAGE_SIZE = 20

export function normalizeGenrePage(value) {
  const page = Number(value)
  if (!Number.isFinite(page) || page < 1) return 1
  return Math.floor(page)
}

export function getGenrePageWindow(value) {
  const page = normalizeGenrePage(value)
  const from = (page - 1) * GENRE_PAGE_SIZE
  const to = from + GENRE_PAGE_SIZE

  return {
    page,
    limit: GENRE_PAGE_SIZE,
    from,
    to,
    fetch_limit: to + 1,
  }
}

export function finalizeGenrePage(rows, value) {
  const items = Array.isArray(rows) ? rows : []
  const { page, limit, from, to } = getGenrePageWindow(value)
  const stories = items.slice(from, to)
  const hasMore = items.length > to

  return {
    stories,
    pagination: {
      page,
      limit,
      has_more: hasMore,
      next_page: hasMore ? page + 1 : null,
    },
  }
}
