import express from 'express'
import { supabase } from '../config/supabase.js'

const router = express.Router()
const MAX_FEATURED_TABS = 12

function slugify(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/\+/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

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

async function getStoryCountsByGenre() {
  const { data, error } = await supabase
    .from('stories')
    .select('main_genre')

  if (error) throw error

  const counts = {}

  for (const story of data || []) {
    const name = String(story.main_genre || '').trim()
    if (!name) continue

    const slug = slugify(name)
    counts[slug] = (counts[slug] || 0) + 1
  }

  return counts
}

async function getGenreById(id) {
  const { data, error } = await supabase
    .from('genres')
    .select('*')
    .eq('id', id)
    .single()

  if (error) throw error
  return data
}

async function getGenres(req, res) {
  try {
    const includeInactive =
      req.query.include_inactive === 'true' ||
      req.query.includeInactive === 'true'

    let query = supabase.from('genres').select('*')

    if (!includeInactive) {
      query = query.eq('is_active', true)
    }

    const { data, error } = await query
      .order('sort_order', { ascending: true })
      .order('name', { ascending: true })

    if (error) throw error

    res.status(200).json({ ok: true, genres: data || [] })
  } catch (error) {
    console.error('GET GENRES ERROR:', error)
    res.status(500).json({ ok: false, message: 'Failed to fetch genres' })
  }
}

async function getAdminGenres(req, res) {
  try {
    const { data, error } = await supabase
      .from('genres')
      .select('*')
      .order('sort_order', { ascending: true })
      .order('name', { ascending: true })

    if (error) throw error

    const counts = await getStoryCountsByGenre()

    res.status(200).json({
      ok: true,
      genres: (data || []).map((genre) => ({
        ...genre,
        story_count: counts[genre.slug] || 0,
      })),
    })
  } catch (error) {
    console.error('GET ADMIN GENRES ERROR:', error)
    res.status(500).json({ ok: false, message: 'Failed to fetch genre records' })
  }
}

async function createGenre(req, res) {
  try {
    const name = String(req.body.name || '').trim()
    const slug = slugify(req.body.slug || name)
    const sortOrder = toNumber(req.body.sort_order, 0)
    const isActive = toBoolean(req.body.is_active, true)

    if (!name) return res.status(400).json({ ok: false, message: 'Genre name is required' })
    if (!slug) return res.status(400).json({ ok: false, message: 'Genre slug is required' })

    const { data, error } = await supabase
      .from('genres')
      .insert({ name, slug, sort_order: sortOrder, is_active: isActive })
      .select()
      .single()

    if (error) throw error

    res.status(201).json({ ok: true, genre: data })
  } catch (error) {
    console.error('CREATE GENRE ERROR:', error)
    res.status(500).json({ ok: false, message: 'Failed to create genre' })
  }
}

async function updateGenre(req, res) {
  try {
    const { id } = req.params
    const oldGenre = await getGenreById(id)

    const name = req.body.name === undefined ? oldGenre.name : String(req.body.name || '').trim()
    const slug = req.body.slug === undefined ? oldGenre.slug : slugify(req.body.slug || name)
    const sortOrder = req.body.sort_order === undefined ? oldGenre.sort_order : toNumber(req.body.sort_order, oldGenre.sort_order)
    const isActive = req.body.is_active === undefined ? oldGenre.is_active : toBoolean(req.body.is_active, oldGenre.is_active)

    if (!name || !slug) return res.status(400).json({ ok: false, message: 'Genre name and slug are required' })

    const { data, error } = await supabase
      .from('genres')
      .update({
        name,
        slug,
        sort_order: sortOrder,
        is_active: isActive,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select()
      .single()

    if (error) throw error

    await supabase
      .from('featured_genre_tabs')
      .update({
        label: data.name,
        slug: data.slug,
        is_active: data.is_active,
        updated_at: new Date().toISOString(),
      })
      .eq('genre_id', id)
      .eq('is_locked', false)

    res.status(200).json({ ok: true, genre: data })
  } catch (error) {
    console.error('UPDATE GENRE ERROR:', error)
    res.status(500).json({ ok: false, message: 'Failed to update genre' })
  }
}

async function deleteGenre(req, res) {
  try {
    const { id } = req.params
    const genre = await getGenreById(id)
    const counts = await getStoryCountsByGenre()
    const storyCount = counts[genre.slug] || 0

    if (storyCount > 0) {
      return res.status(409).json({
        ok: false,
        message: 'This genre is used by stories. Disable it instead.',
        story_count: storyCount,
      })
    }

    await supabase.from('featured_genre_tabs').delete().eq('genre_id', id).eq('is_locked', false)

    const { error } = await supabase.from('genres').delete().eq('id', id)
    if (error) throw error

    res.status(200).json({ ok: true, deleted_id: id })
  } catch (error) {
    console.error('DELETE GENRE ERROR:', error)
    res.status(500).json({ ok: false, message: 'Failed to delete genre' })
  }
}

async function getFeaturedGenreTabs(req, res) {
  try {
    const includeInactive =
      req.query.include_inactive === 'true' ||
      req.query.includeInactive === 'true'

    let query = supabase.from('featured_genre_tabs').select('*, genre:genres(*)')

    if (!includeInactive) query = query.eq('is_active', true)

    const { data, error } = await query
      .order('sort_order', { ascending: true })
      .limit(MAX_FEATURED_TABS)

    if (error) throw error

    res.status(200).json({ ok: true, max_tabs: MAX_FEATURED_TABS, tabs: data || [] })
  } catch (error) {
    console.error('GET FEATURED GENRE TABS ERROR:', error)
    res.status(500).json({ ok: false, message: 'Failed to fetch featured genre tabs' })
  }
}

async function updateFeaturedGenreTabs(req, res) {
  try {
    const rawGenreIds = Array.isArray(req.body.genre_ids) ? req.body.genre_ids : []
    const uniqueGenreIds = [...new Set(rawGenreIds.map((id) => String(id || '').trim()).filter(Boolean))]
    const selectedGenreIds = uniqueGenreIds.slice(0, MAX_FEATURED_TABS - 1)

    const { data: selectedGenres, error: selectedGenresError } = await supabase
      .from('genres')
      .select('*')
      .in('id', selectedGenreIds.length ? selectedGenreIds : ['00000000-0000-0000-0000-000000000000'])
      .eq('is_active', true)

    if (selectedGenresError) throw selectedGenresError

    const selectedMap = new Map((selectedGenres || []).map((genre) => [genre.id, genre]))
    const orderedGenres = selectedGenreIds.map((id) => selectedMap.get(id)).filter(Boolean)

    await supabase.from('featured_genre_tabs').delete().eq('is_locked', false)

    const rows = orderedGenres.map((genre, index) => ({
      genre_id: genre.id,
      label: genre.name,
      slug: genre.slug,
      is_locked: false,
      is_active: true,
      sort_order: (index + 1) * 10,
      updated_at: new Date().toISOString(),
    }))

    if (rows.length) {
      const { error: insertError } = await supabase.from('featured_genre_tabs').insert(rows)
      if (insertError) throw insertError
    }

    const { data: todayTab } = await supabase
      .from('featured_genre_tabs')
      .select('*')
      .eq('slug', 'today')
      .maybeSingle()

    if (!todayTab) {
      await supabase.from('featured_genre_tabs').insert({
        label: 'Today',
        slug: 'today',
        is_locked: true,
        is_active: true,
        sort_order: 0,
      })
    } else {
      await supabase
        .from('featured_genre_tabs')
        .update({
          label: 'Today',
          slug: 'today',
          is_locked: true,
          is_active: true,
          sort_order: 0,
          updated_at: new Date().toISOString(),
        })
        .eq('id', todayTab.id)
    }

    const { data: tabs, error: tabsError } = await supabase
      .from('featured_genre_tabs')
      .select('*, genre:genres(*)')
      .eq('is_active', true)
      .order('sort_order', { ascending: true })
      .limit(MAX_FEATURED_TABS)

    if (tabsError) throw tabsError

    res.status(200).json({ ok: true, max_tabs: MAX_FEATURED_TABS, tabs: tabs || [] })
  } catch (error) {
    console.error('UPDATE FEATURED GENRE TABS ERROR:', error)
    res.status(500).json({ ok: false, message: 'Failed to update featured genre tabs' })
  }
}

router.get('/', getGenres)
router.get('/featured-tabs', getFeaturedGenreTabs)
router.get('/admin/records', getAdminGenres)
router.post('/admin/records', createGenre)
router.put('/admin/records/:id', updateGenre)
router.delete('/admin/records/:id', deleteGenre)
router.put('/admin/featured-tabs', updateFeaturedGenreTabs)

export default router
