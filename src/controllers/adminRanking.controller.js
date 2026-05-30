import { supabase } from '../config/supabase.js'

const PAGE_SIZE_DEFAULT = 20
const PAGE_SIZE_MAX = 100

function cleanText(value) {
  return String(value || '').trim()
}

function normalizePage(value) {
  const page = Number(value)
  if (!Number.isFinite(page) || page < 1) return 1
  return Math.floor(page)
}

function normalizeLimit(value) {
  const limit = Number(value)
  if (!Number.isFinite(limit) || limit < 1) return PAGE_SIZE_DEFAULT
  return Math.min(Math.floor(limit), PAGE_SIZE_MAX)
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{12}$/i.test(String(value || '').trim())
}

function normalizeSort(value) {
  const sort = cleanText(value || 'score').toLowerCase()
  if (['views', 'likes', 'comments', 'episodes', 'newest'].includes(sort)) return sort
  return 'score'
}

function scoreStory(story) {
  return Number(story.total_views || 0) + Number(story.total_likes || 0) * 5 + Number(story.total_comments || 0) * 10 + Number(story.total_episodes || 0) * 3
}

function publicAuthor(author) {
  if (!author) return null

  return {
    id: author.id,
    user_id: author.user_id,
    page_name: author.page_name,
    page_username: author.page_username,
    page_slug: author.page_slug,
    avatar_url: author.avatar_url,
    status: author.status,
    admin_status: author.admin_status || 'active',
  }
}

function publicStoryRank(story, author, rank) {
  return {
    rank,
    id: story.id,
    author_id: story.author_id,
    user_id: story.user_id,
    title: story.title,
    story_language: story.story_language,
    main_genre: story.main_genre,
    cover_url: story.cover_url,
    status: story.status,
    admin_visibility_status: story.admin_visibility_status || 'active',
    total_episodes: Number(story.total_episodes || 0),
    total_views: Number(story.total_views || 0),
    total_likes: Number(story.total_likes || 0),
    total_comments: Number(story.total_comments || 0),
    score: scoreStory(story),
    author_page: publicAuthor(author),
    created_at: story.created_at,
    updated_at: story.updated_at,
  }
}

async function fetchAuthors(authorIds) {
  const ids = [...new Set((authorIds || []).filter(Boolean))]
  if (!ids.length) return new Map()

  const { data, error } = await supabase
    .from('author_pages')
    .select('id, user_id, page_name, page_username, page_slug, avatar_url, status, admin_status')
    .in('id', ids)

  if (error) throw error

  return new Map((data || []).map((author) => [author.id, author]))
}

function applySort(rows, sort) {
  const sorted = [...rows]

  if (sort === 'views') return sorted.sort((a, b) => Number(b.total_views || 0) - Number(a.total_views || 0))
  if (sort === 'likes') return sorted.sort((a, b) => Number(b.total_likes || 0) - Number(a.total_likes || 0))
  if (sort === 'comments') return sorted.sort((a, b) => Number(b.total_comments || 0) - Number(a.total_comments || 0))
  if (sort === 'episodes') return sorted.sort((a, b) => Number(b.total_episodes || 0) - Number(a.total_episodes || 0))
  if (sort === 'newest') return sorted.sort((a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime())

  return sorted.sort((a, b) => scoreStory(b) - scoreStory(a))
}

export async function getAdminStoryRanking(req, res) {
  try {
    const page = normalizePage(req.query.page)
    const limit = normalizeLimit(req.query.limit)
    const sort = normalizeSort(req.query.sort)
    const search = cleanText(req.query.q || req.query.search || req.query.keyword)
    const status = cleanText(req.query.status || 'published').toLowerCase()
    const visibility = cleanText(req.query.visibility || 'active').toLowerCase()
    const genre = cleanText(req.query.genre || 'all')

    let query = supabase
      .from('stories')
      .select('*')
      .is('deleted_at', null)

    if (status !== 'all') query = query.eq('status', status)
    if (visibility !== 'all') query = query.eq('admin_visibility_status', visibility)
    if (genre !== 'all') query = query.eq('main_genre', genre)

    if (search) {
      if (isUuid(search)) {
        query = query.eq('id', search)
      } else {
        const safeSearch = search.replace(/[%_]/g, '\\$&')
        query = query.or(`title.ilike.%${safeSearch}%,main_genre.ilike.%${safeSearch}%,story_language.ilike.%${safeSearch}%`)
      }
    }

    const { data, error } = await query

    if (error) throw error

    const rows = applySort(data || [], sort)
    const total = rows.length
    const totalPages = Math.max(1, Math.ceil(total / limit))
    const from = (page - 1) * limit
    const pageRows = rows.slice(from, from + limit)
    const authors = await fetchAuthors(pageRows.map((story) => story.author_id))
    const rankings = pageRows.map((story, index) => publicStoryRank(story, authors.get(story.author_id), from + index + 1))
    const genreValues = [...new Set((data || []).map((story) => story.main_genre).filter(Boolean))].sort()

    return res.status(200).json({
      ok: true,
      rankings,
      page,
      limit,
      total,
      total_pages: totalPages,
      has_next: page < totalPages,
      has_prev: page > 1,
      sort,
      filters: {
        status,
        visibility,
        genre,
        genres: genreValues,
      },
      formula: 'score = views + likes*5 + comments*10 + episodes*3',
    })
  } catch (error) {
    console.error('GET ADMIN STORY RANKING ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to load story ranking', error: error.message })
  }
}
