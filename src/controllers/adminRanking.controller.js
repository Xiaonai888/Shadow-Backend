import { supabase } from '../config/supabase.js'

const PAGE_SIZE_DEFAULT = 20
const PAGE_SIZE_MAX = 100
const RANKING_VISIBILITY_STATUSES = ['visible', 'hidden']

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
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || '').trim())
}

function normalizeSort(value) {
  const sort = cleanText(value || 'score').toLowerCase()
  if (['views', 'likes', 'comments', 'episodes', 'newest'].includes(sort)) return sort
  return 'score'
}

function adminActor(req) {
  return cleanText(req.admin?.email || req.admin?.username || req.admin?.admin_name || req.admin?.user_id || req.headers['x-admin-name'] || req.headers['x-admin-actor'] || 'Admin')
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
    ranking_visibility_status: story.ranking_visibility_status || 'visible',
    ranking_hidden_reason: story.ranking_hidden_reason || '',
    ranking_hidden_at: story.ranking_hidden_at || null,
    ranking_hidden_by: story.ranking_hidden_by || '',
    ranking_note: story.ranking_note || '',
    total_episodes: Number(story.total_episodes || 0),
    total_views: Number(story.total_views || 0),
    total_likes: Number(story.total_likes || 0),
    total_comments: Number(story.total_comments || 0),
    score: scoreStory(story),
    rank_score: scoreStory(story),
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

function buildStoryRankingQuery({ search, status, visibility, rankingVisibility, genre }) {
  let query = supabase
    .from('stories')
    .select('*')
    .is('deleted_at', null)

  if (status !== 'all') query = query.eq('status', status)
  if (visibility !== 'all') query = query.eq('admin_visibility_status', visibility)
  if (rankingVisibility !== 'all') query = query.eq('ranking_visibility_status', rankingVisibility)
  if (genre !== 'all') query = query.eq('main_genre', genre)

  if (search) {
    if (isUuid(search)) {
      query = query.eq('id', search)
    } else {
      const safeSearch = search.replace(/[%_]/g, '\\$&')
      query = query.or(`title.ilike.%${safeSearch}%,main_genre.ilike.%${safeSearch}%,story_language.ilike.%${safeSearch}%`)
    }
  }

  return query
}

export async function getAdminStoryRanking(req, res) {
  try {
    const page = normalizePage(req.query.page)
    const limit = normalizeLimit(req.query.limit)
    const sort = normalizeSort(req.query.sort || req.query.metric)
    const search = cleanText(req.query.q || req.query.search || req.query.keyword)
    const status = cleanText(req.query.status || 'published').toLowerCase()
    const visibility = cleanText(req.query.visibility || 'active').toLowerCase()
    const rankingVisibility = cleanText(req.query.ranking_visibility || req.query.rankingVisibility || 'visible').toLowerCase()
    const genre = cleanText(req.query.genre || 'all')

    const { data, error } = await buildStoryRankingQuery({ search, status, visibility, rankingVisibility, genre })

    if (error) throw error

    const rows = applySort(data || [], sort)
    const total = rows.length
    const totalPages = Math.max(1, Math.ceil(total / limit))
    const from = (page - 1) * limit
    const pageRows = rows.slice(from, from + limit)
    const authors = await fetchAuthors(pageRows.map((story) => story.author_id))
    const stories = pageRows.map((story, index) => publicStoryRank(story, authors.get(story.author_id), from + index + 1))
    const genreValues = [...new Set((data || []).map((story) => story.main_genre).filter(Boolean))].sort()

    return res.status(200).json({
      ok: true,
      stories,
      rankings: stories,
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
        ranking_visibility: rankingVisibility,
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

export async function getHiddenRankingItems(req, res) {
  try {
    const page = normalizePage(req.query.page)
    const limit = normalizeLimit(req.query.limit)
    const search = cleanText(req.query.q || req.query.search || req.query.keyword)
    const genre = cleanText(req.query.genre || 'all')
    const from = (page - 1) * limit
    const to = from + limit - 1

    let query = supabase
      .from('stories')
      .select('*', { count: 'exact' })
      .eq('ranking_visibility_status', 'hidden')

    if (genre !== 'all') query = query.eq('main_genre', genre)

    if (search) {
      if (isUuid(search)) {
        query = query.eq('id', search)
      } else {
        const safeSearch = search.replace(/[%_]/g, '\\$&')
        query = query.or(`title.ilike.%${safeSearch}%,main_genre.ilike.%${safeSearch}%,story_language.ilike.%${safeSearch}%,ranking_hidden_reason.ilike.%${safeSearch}%`)
      }
    }

    const { data, count, error } = await query
      .order('ranking_hidden_at', { ascending: false, nullsFirst: false })
      .range(from, to)

    if (error) throw error

    const authors = await fetchAuthors((data || []).map((story) => story.author_id))
    const stories = (data || []).map((story, index) => publicStoryRank(story, authors.get(story.author_id), from + index + 1))
    const total = count || 0
    const totalPages = Math.max(1, Math.ceil(total / limit))

    return res.status(200).json({
      ok: true,
      items: stories,
      stories,
      page,
      limit,
      total,
      total_pages: totalPages,
      has_next: page < totalPages,
      has_prev: page > 1,
    })
  } catch (error) {
    console.error('GET HIDDEN RANKING ITEMS ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to load hidden ranking items', error: error.message })
  }
}

export async function updateStoryRankingVisibility(req, res) {
  try {
    const { storyId } = req.params
    const rankingVisibility = cleanText(req.body.ranking_visibility_status || req.body.ranking_visibility || req.body.visibility).toLowerCase()
    const reason = cleanText(req.body.reason || req.body.ranking_hidden_reason)
    const note = cleanText(req.body.note || req.body.ranking_note)
    const actor = adminActor(req)

    if (!RANKING_VISIBILITY_STATUSES.includes(rankingVisibility)) {
      return res.status(400).json({ ok: false, message: 'Invalid ranking visibility status' })
    }

    if (rankingVisibility === 'hidden' && reason.length < 5) {
      return res.status(400).json({ ok: false, message: 'Hidden reason is required' })
    }

    const { data: oldStory, error: oldStoryError } = await supabase
      .from('stories')
      .select('*')
      .eq('id', storyId)
      .maybeSingle()

    if (oldStoryError) throw oldStoryError
    if (!oldStory) return res.status(404).json({ ok: false, message: 'Story not found' })

    const now = new Date().toISOString()
    const updatePayload = {
      ranking_visibility_status: rankingVisibility,
      ranking_hidden_reason: rankingVisibility === 'hidden' ? reason : '',
      ranking_hidden_at: rankingVisibility === 'hidden' ? now : null,
      ranking_hidden_by: rankingVisibility === 'hidden' ? actor : '',
      ranking_note: note || oldStory.ranking_note || '',
      updated_at: now,
    }

    const { data: story, error: updateError } = await supabase
      .from('stories')
      .update(updatePayload)
      .eq('id', storyId)
      .select()
      .single()

    if (updateError) throw updateError

    await supabase.from('ranking_moderation_logs').insert({
      item_type: 'story',
      item_id: storyId,
      story_id: storyId,
      author_id: story.author_id,
      action: rankingVisibility === 'hidden' ? 'story_hidden_from_ranking' : 'story_unhidden_from_ranking',
      reason: rankingVisibility === 'hidden' ? reason : 'Story restored to ranking by admin',
      admin_actor: actor,
    })

    const authors = await fetchAuthors([story.author_id])

    return res.status(200).json({
      ok: true,
      message: rankingVisibility === 'hidden' ? 'Story hidden from ranking' : 'Story restored to ranking',
      story: publicStoryRank(story, authors.get(story.author_id), null),
    })
  } catch (error) {
    console.error('UPDATE STORY RANKING VISIBILITY ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to update ranking visibility', error: error.message })
  }
}
