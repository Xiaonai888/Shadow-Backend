import { supabase } from '../config/supabase.js'

function toBoolean(value, fallback = true) {
  if (value === undefined || value === null || value === '') return fallback
  if (value === true || value === 'true') return true
  if (value === false || value === 'false') return false
  return fallback
}

function toNumber(value, fallback = 0) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function toGenres(value) {
  if (Array.isArray(value)) return value
  if (!value) return []
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

function makeSlug(title) {
  return String(title || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
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

async function refreshBookEpisodeCount(bookId) {
  const { count, error } = await supabase
    .from('episodes')
    .select('id', { count: 'exact', head: true })
    .eq('book_id', bookId)
    .eq('is_published', true)

  if (error) throw error

  await supabase
    .from('books')
    .update({
      total_episodes: count || 0,
      updated_at: new Date().toISOString(),
    })
    .eq('id', bookId)
}

export async function getBooks(req, res) {
  try {
    const page = Math.max(toNumber(req.query.page, 1), 1)
    const limit = Math.min(Math.max(toNumber(req.query.limit, 20), 1), 50)
    const search = String(req.query.search || '').trim()
    const genre = String(req.query.genre || '').trim()
    const status = String(req.query.status || '').trim()
    const includeInactive = req.query.include_inactive === 'true'
    const from = (page - 1) * limit
    const to = from + limit - 1

    let query = supabase.from('books').select('*', { count: 'exact' })

    if (!includeInactive) query = query.eq('is_active', true)
    if (search) query = query.ilike('title', `%${search}%`)
    if (genre) query = query.contains('genres', [genre])
    if (status) query = query.eq('status', status)

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
    res.status(500).json({ ok: false, message: 'Failed to fetch books', error: error.message })
  }
}

export async function getBookById(req, res) {
  try {
    const { id } = req.params

    const { data, error } = await supabase
      .from('books')
      .select('*')
      .eq('id', id)
      .single()

    if (error || !data) {
      return res.status(404).json({ ok: false, message: 'Book not found' })
    }

    res.status(200).json({ ok: true, book: normalizeBook(data) })
  } catch (error) {
    console.error('GET BOOK BY ID ERROR:', error)
    res.status(500).json({ ok: false, message: 'Failed to fetch book', error: error.message })
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
    res.status(500).json({ ok: false, message: 'Failed to fetch episodes', error: error.message })
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

    if (error || !data) {
      return res.status(404).json({ ok: false, message: 'Episode not found' })
    }

    res.status(200).json({
      ok: true,
      episode: normalizeEpisode(data),
      book: data.books || null,
    })
  } catch (error) {
    console.error('GET EPISODE BY ID ERROR:', error)
    res.status(500).json({ ok: false, message: 'Failed to fetch episode', error: error.message })
  }
}

export async function createBook(req, res) {
  try {
    const {
      title,
      slug,
      author_name = '',
      cover_url = '',
      description = '',
      genres = [],
      status = 'ongoing',
      is_premium = false,
      is_active = true,
    } = req.body

    if (!title) {
      return res.status(400).json({ ok: false, message: 'Book title is required' })
    }

    const { data, error } = await supabase
      .from('books')
      .insert({
        title,
        slug: slug || makeSlug(title),
        author_name,
        cover_url,
        description,
        genres: toGenres(genres),
        status,
        is_premium: toBoolean(is_premium, false),
        is_active: toBoolean(is_active, true),
        updated_at: new Date().toISOString(),
      })
      .select()
      .single()

    if (error) throw error

    res.status(201).json({ ok: true, book: normalizeBook(data) })
  } catch (error) {
    console.error('CREATE BOOK ERROR:', error)
    res.status(500).json({ ok: false, message: 'Failed to create book', error: error.message })
  }
}

export async function updateBook(req, res) {
  try {
    const { id } = req.params
    const updatePayload = { updated_at: new Date().toISOString() }

    const allowedFields = ['title', 'slug', 'author_name', 'cover_url', 'description', 'status']

    for (const field of allowedFields) {
      if (req.body[field] !== undefined) updatePayload[field] = req.body[field]
    }

    if (req.body.genres !== undefined) updatePayload.genres = toGenres(req.body.genres)
    if (req.body.is_premium !== undefined) updatePayload.is_premium = toBoolean(req.body.is_premium, false)
    if (req.body.is_active !== undefined) updatePayload.is_active = toBoolean(req.body.is_active, true)
    if (req.body.title && !req.body.slug) updatePayload.slug = makeSlug(req.body.title)

    const { data, error } = await supabase
      .from('books')
      .update(updatePayload)
      .eq('id', id)
      .select()
      .single()

    if (error) throw error

    res.status(200).json({ ok: true, book: normalizeBook(data) })
  } catch (error) {
    console.error('UPDATE BOOK ERROR:', error)
    res.status(500).json({ ok: false, message: 'Failed to update book', error: error.message })
  }
}

export async function deleteBook(req, res) {
  try {
    const { id } = req.params

    const { data, error } = await supabase
      .from('books')
      .update({
        is_active: false,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select()
      .single()

    if (error) throw error

    res.status(200).json({ ok: true, book: normalizeBook(data) })
  } catch (error) {
    console.error('DELETE BOOK ERROR:', error)
    res.status(500).json({ ok: false, message: 'Failed to delete book', error: error.message })
  }
}

export async function createEpisode(req, res) {
  try {
    const { id: bookId } = req.params
    const {
      episode_number,
      title,
      content = '',
      is_free = true,
      is_published = true,
    } = req.body

    if (!episode_number || !title) {
      return res.status(400).json({
        ok: false,
        message: 'Episode number and title are required',
      })
    }

    const { data, error } = await supabase
      .from('episodes')
      .insert({
        book_id: bookId,
        episode_number: toNumber(episode_number),
        title,
        content,
        is_free: toBoolean(is_free, true),
        is_published: toBoolean(is_published, true),
        published_at: toBoolean(is_published, true) ? new Date().toISOString() : null,
        updated_at: new Date().toISOString(),
      })
      .select()
      .single()

    if (error) throw error

    await refreshBookEpisodeCount(bookId)

    res.status(201).json({ ok: true, episode: normalizeEpisode(data) })
  } catch (error) {
    console.error('CREATE EPISODE ERROR:', error)
    res.status(500).json({ ok: false, message: 'Failed to create episode', error: error.message })
  }
}

export async function updateEpisode(req, res) {
  try {
    const { id } = req.params
    const updatePayload = { updated_at: new Date().toISOString() }

    const allowedFields = ['title', 'content']

    for (const field of allowedFields) {
      if (req.body[field] !== undefined) updatePayload[field] = req.body[field]
    }

    if (req.body.episode_number !== undefined) updatePayload.episode_number = toNumber(req.body.episode_number)
    if (req.body.is_free !== undefined) updatePayload.is_free = toBoolean(req.body.is_free, true)
    if (req.body.is_published !== undefined) {
      updatePayload.is_published = toBoolean(req.body.is_published, true)
      updatePayload.published_at = updatePayload.is_published ? new Date().toISOString() : null
    }

    const { data, error } = await supabase
      .from('episodes')
      .update(updatePayload)
      .eq('id', id)
      .select()
      .single()

    if (error) throw error

    await refreshBookEpisodeCount(data.book_id)

    res.status(200).json({ ok: true, episode: normalizeEpisode(data) })
  } catch (error) {
    console.error('UPDATE EPISODE ERROR:', error)
    res.status(500).json({ ok: false, message: 'Failed to update episode', error: error.message })
  }
}

export async function deleteEpisode(req, res) {
  try {
    const { id } = req.params

    const { data: existingEpisode, error: existingError } = await supabase
      .from('episodes')
      .select('*')
      .eq('id', id)
      .single()

    if (existingError) throw existingError

    const { error } = await supabase
      .from('episodes')
      .delete()
      .eq('id', id)

    if (error) throw error

    await refreshBookEpisodeCount(existingEpisode.book_id)

    res.status(200).json({ ok: true, episode: normalizeEpisode(existingEpisode) })
  } catch (error) {
    console.error('DELETE EPISODE ERROR:', error)
    res.status(500).json({ ok: false, message: 'Failed to delete episode', error: error.message })
  }
}
