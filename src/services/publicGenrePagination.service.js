export const GENRE_PAGE_SIZE = 20

export function normalizeGenrePage(value) {
  const page = Number(value)
  if (!Number.isFinite(page) || page < 1) return 1
  return Math.floor(page)
}

export function getGenrePageWindow(value) {
  const page = normalizeGenrePage(value)
  const from = (page - 1) * GENRE_PAGE_SIZE
  return {
    page,
    limit: GENRE_PAGE_SIZE,
    from,
    to: from + GENRE_PAGE_SIZE,
  }
}

export function finalizeGenrePage(rows, value) {
  const page = normalizeGenrePage(value)
  const items = Array.isArray(rows) ? rows : []
  const stories = items.slice(0, GENRE_PAGE_SIZE)
  const hasMore = items.length > GENRE_PAGE_SIZE

  return {
    stories,
    pagination: {
      page,
      limit: GENRE_PAGE_SIZE,
      has_more: hasMore,
      next_page: hasMore ? page + 1 : null,
    },
  }
}
