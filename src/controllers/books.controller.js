import { supabase } from '../config/supabase.js'

function toNumber(value, fallback = 0) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function normalizeBook(book) {
  return {
    id: book.id,
    title: book.title,
    slug: book.slug,
    author_name: book.author_name,
    cover_url: book.cover_url,
    description: book.description,
    genres: book.genres || [],
    status: book.status,
    is_premium: Boolean(book.is_premium),
    is_active: Boolean(book.is_active),
    total_episodes: book.total_episodes || 0,
    views_count: book.views_count || 0,
    likes_count: book.likes_count || 0,
    rating: book.rating || 0,
    created_at: book.created_at,
    updated_at: book.updated_at,
  }
}

function normalizeEpisode(episode) {
  return {
    id: episode.id,
    book_id: episode.book_id,
    episode_number: episode.episode_number,
    title: episode.title,
    content: episode.content,
    is_free: Boolean(episode.is_free),
    is_published: Boolean(episode.is_published),
    published_at: episode.published_at,
    created_at: episode.created_at,
    updated_at: episode.updated_at,
  }
}

export async function getBooks(req, res) {
  try {
    const page = Math.max(toNumber(req.query.page, 1), 1)
    const limit = Math.min(Math.max(toNumber(req.query.limit, 20), 1), 50)
    const search = String(req.query.search || '').trim()
    const genre = String(req.query.genre || '').trim()
    const status = String(req.query.status || '').trim()
    const from = (page - 1) * limit
    const to = from + limit - 1

    let query = supabase
      .from('books')
      .select('*', { count: 'exact' })
      .eq('is_active', true)

    if (search) {
      query = query.ilike('title', `%${search}%`)
    }

    if (genre) {
      query = query.contains('genres', [genre])
    }

    if (status) {
      query = query.eq('status', status)
    }

    const { data, error, count } = await query
      .order('updated_at', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false })
      .range(from, to)

    if (error) throw error

    res.status(200).json({
      ok: true,
      books: (data || []).map(normalizeBook),
      page,
      limit,
      total: count || 0,
      total_pages: Math.max(Math.ceil((count || 0) / limit), 1),
    })
  } catch (error) {
    console.error('GET BOOKS ERROR:', error)

    res.status(500).json({
  ok: false,
  message: 'Failed to fetch books',
  error: error.message,
})
  }
}

export async function getBookById(req, res) {
  try {
    const { id } = req.params

    const { data, error } = await supabase
      .from('books')
      .select('*')
      .eq('id', id)
      .eq('is_active', true)
      .single()

    if (error) {
      return res.status(404).json({
        ok: false,
        message: 'Book not found',
      })
    }

    res.status(200).json({
      ok: true,
      book: normalizeBook(data),
    })
  } catch (error) {
    console.error('GET BOOK BY ID ERROR:', error)

    res.status(500).json({
      ok: false,
      message: 'Failed to fetch book',
    })
  }
}

export async function getBookEpisodes(req, res) {
  try {
    const { id } = req.params
    const includeContent = req.query.include_content === 'true'

    const selectFields = includeContent
      ? '*'
      : 'id, book_id, episode_number, title, is_free, is_published, published_at, created_at, updated_at'

    const { data, error } = await supabase
      .from('episodes')
      .select(selectFields)
      .eq('book_id', id)
      .eq('is_published', true)
      .order('episode_number', { ascending: true })

    if (error) throw error

    res.status(200).json({
      ok: true,
      episodes: (data || []).map((episode) => ({
        ...normalizeEpisode({ content: '', ...episode }),
        content: includeContent ? episode.content : undefined,
      })),
    })
  } catch (error) {
    console.error('GET BOOK EPISODES ERROR:', error)

    res.status(500).json({
      ok: false,
      message: 'Failed to fetch episodes',
    })
  }
}

export async function getEpisodeById(req, res) {
  try {
    const { id } = req.params

    const { data, error } = await supabase
      .from('episodes')
      .select('*, books(id, title, slug, author_name, cover_url)')
      .eq('id', id)
      .eq('is_published', true)
      .single()

    if (error) {
      return res.status(404).json({
        ok: false,
        message: 'Episode not found',
      })
    }

    res.status(200).json({
      ok: true,
      episode: normalizeEpisode(data),
      book: data.books || null,
    })
  } catch (error) {
    console.error('GET EPISODE BY ID ERROR:', error)

    res.status(500).json({
      ok: false,
      message: 'Failed to fetch episode',
    })
  }
}
