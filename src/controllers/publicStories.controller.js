import { supabase } from '../config/supabase.js'
import jwt from 'jsonwebtoken'


function publicAuthorPage(page) {
  if (!page) return null

  return {
    id: page.id,
    user_id: page.user_id,
    page_name: page.page_name,
    page_username: page.page_username,
    page_slug: page.page_slug,
    bio: page.bio,
    avatar_url: page.avatar_url,
    cover_url: page.cover_url,
    status: page.status,
    total_stories: page.total_stories,
    total_followers: page.total_followers,
    created_at: page.created_at,
    updated_at: page.updated_at,
  }
}

function publicStory(story, slides = [], authorPage = null) {
  if (!story) return null

  return {
    id: story.id,
    author_id: story.author_id,
    user_id: story.user_id,
    title: story.title,
    story_language: story.story_language,
    main_genre: story.main_genre,
    tags: story.tags || [],
    description: story.description,
    is_adult: story.is_adult,
    cover_url: story.cover_url,
    status: story.status,
    access_type: story.access_type || 'free',
    is_shadow_exclusive: Boolean(story.is_shadow_exclusive),
    exclusive_status: story.exclusive_status || 'none',
    exclusive_sections: story.exclusive_sections || [],
    update_days: story.update_days || [],
    total_episodes: story.total_episodes,
    total_views: story.total_views,
    total_likes: story.total_likes,
    total_comments: story.total_comments,
    author_page: publicAuthorPage(authorPage),
    slides,
    created_at: story.created_at,
    updated_at: story.updated_at,
  }
}

function publicStoryListItem(story) {
  if (!story) return null

  return {
    id: story.id,
    author_id: story.author_id,
    user_id: story.user_id,
    title: story.title,
    story_language: story.story_language,
    main_genre: story.main_genre,
    tags: story.tags || [],
    description: story.description,
    is_adult: story.is_adult,
    cover_url: story.cover_url,
    status: story.status,
    access_type: story.access_type || 'free',
    is_shadow_exclusive: Boolean(story.is_shadow_exclusive),
    exclusive_status: story.exclusive_status || 'none',
    exclusive_sections: story.exclusive_sections || [],
    update_days: story.update_days || [],
    total_episodes: story.total_episodes,
    total_views: story.total_views,
    total_likes: story.total_likes,
    total_comments: story.total_comments,
    created_at: story.created_at,
    updated_at: story.updated_at,
  }
}

function publicEpisodeListItem(episode) {
  if (!episode) return null

  return {
    id: episode.id,
    story_id: episode.story_id,
    title: episode.title,
    cover_url: episode.cover_url,
    is_adult: episode.is_adult,
    is_locked: Boolean(episode.is_locked),
    unlock_methods: episode.unlock_methods || [],
    status: episode.status,
    episode_number: episode.episode_number,
    character_count: episode.character_count,
    published_at: episode.published_at,
    created_at: episode.created_at,
    updated_at: episode.updated_at,
  }
}

function publicEpisode(episode) {
  ADD:
function getOptionalUserId(req) {
  try {
    const authHeader = req.headers.authorization || ''
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''

    if (!token || !process.env.JWT_SECRET) return ''

    const decoded = jwt.verify(token, process.env.JWT_SECRET)

    if (decoded.type !== 'reader') return ''

    return decoded.user_id || ''
  } catch {
    return ''
  }
}

function isEpisodeFreeForReader(episode) {
  return !episode?.is_locked || Number(episode?.episode_number || 0) <= 1
}

async function hasActiveEpisodeUnlock({ userId, episodeId }) {
  if (!userId || !episodeId) return false

  const { data, error } = await supabase
    .from('episode_unlocks')
    .select('id, access_type, expires_at, unlock_status')
    .eq('user_id', userId)
    .eq('episode_id', episodeId)
    .eq('unlock_status', 'active')
    .maybeSingle()

  if (error) throw error
  if (!data) return false

  if (data.expires_at && new Date(data.expires_at).getTime() < Date.now()) {
    return false
  }

  return true
}
  if (!episode) return null

  return {
    id: episode.id,
    story_id: episode.story_id,
    title: episode.title,
    cover_url: episode.cover_url,
    content: episode.content,
    is_adult: episode.is_adult,
    is_locked: Boolean(episode.is_locked),
    unlock_methods: episode.unlock_methods || [],
    status: episode.status,
    episode_number: episode.episode_number,
    character_count: episode.character_count,
    published_at: episode.published_at,
    created_at: episode.created_at,
    updated_at: episode.updated_at,
  }
}

function normalizeLimit(value, fallback = 12, max = 48) {
  const number = Number(value)

  if (!Number.isFinite(number) || number <= 0) return fallback

  return Math.min(Math.floor(number), max)
}

function normalizeSearch(value) {
  return String(value || '').trim().replace(/[%_]/g, '\\$&')
}

function applyStorySort(query, sort) {
  if (sort === 'weekly_top' || sort === 'weekly' || sort === 'trending') {
    return query.order('total_views', { ascending: false }).order('updated_at', { ascending: false })
  }

  if (sort === 'popular') {
    return query.order('total_likes', { ascending: false }).order('total_views', { ascending: false }).order('updated_at', { ascending: false })
  }

  if (sort === 'likes') {
    return query.order('total_likes', { ascending: false }).order('updated_at', { ascending: false })
  }

  if (sort === 'updated') {
    return query.order('updated_at', { ascending: false })
  }

  if (sort === 'new' || sort === 'newest' || sort === 'latest') {
    return query.order('created_at', { ascending: false })
  }

  return query.order('created_at', { ascending: false })
}

async function getAuthorPageById(authorId) {
  if (!authorId) return null

  const { data, error } = await supabase
    .from('author_pages')
    .select('*')
    .eq('id', authorId)
    .maybeSingle()

  if (error) throw error
  return data
}

async function getPublishedReadableStory(storyId) {
  const { data, error } = await supabase
    .from('stories')
    .select('*')
    .eq('id', storyId)
    .eq('status', 'published')
    .maybeSingle()

  if (error) throw error
  return data
}

async function getApprovedExclusiveStory(storyId) {
  const { data, error } = await supabase
    .from('stories')
    .select('*')
    .eq('id', storyId)
    .eq('status', 'published')
    .eq('is_shadow_exclusive', true)
    .eq('exclusive_status', 'approved')
    .maybeSingle()

  if (error) throw error
  return data
}

export async function getPublicStories(req, res) {
  try {
    const limit = normalizeLimit(req.query.limit, 10, 48)
    const genre = String(req.query.genre || '').trim()
    const language = String(req.query.language || '').trim()
    const sort = String(req.query.sort || 'latest').trim()
    const authorId = String(req.query.authorId || req.query.author_id || '').trim()
    const exclude = String(req.query.exclude || req.query.excludeId || req.query.exclude_id || '').trim()
    const search = normalizeSearch(req.query.q || req.query.search || req.query.keyword)

    let query = supabase
      .from('stories')
      .select('*')
      .eq('status', 'published')
      .neq('is_shadow_exclusive', true)
      .limit(limit)

    if (genre) query = query.eq('main_genre', genre)
    if (language) query = query.eq('story_language', language)
    if (authorId) query = query.eq('author_id', authorId)
    if (exclude) query = query.neq('id', exclude)

    if (search) {
      query = query.or(`title.ilike.%${search}%,description.ilike.%${search}%,main_genre.ilike.%${search}%`)
    }

    query = applyStorySort(query, sort)

    const { data, error } = await query

    if (error) throw error

    return res.status(200).json({
      ok: true,
      stories: (data || []).map(publicStoryListItem),
    })
  } catch (error) {
    console.error('GET PUBLIC STORIES ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load stories',
      error: error.message,
    })
  }
}

export async function getPublicShadowExclusiveStories(req, res) {
  try {
    const limit = normalizeLimit(req.query.limit)
    const section = String(req.query.section || '').trim()
    const genre = String(req.query.genre || '').trim()
    const language = String(req.query.language || '').trim()
    const sort = String(req.query.sort || 'updated').trim()

    let query = supabase
      .from('stories')
      .select('*')
      .eq('status', 'published')
      .eq('is_shadow_exclusive', true)
      .eq('exclusive_status', 'approved')
      .limit(limit)

    if (section) query = query.contains('exclusive_sections', [section])
    if (genre) query = query.eq('main_genre', genre)
    if (language) query = query.eq('story_language', language)

    query = applyStorySort(query, sort)

    const { data, error } = await query

    if (error) throw error

    return res.status(200).json({
      ok: true,
      stories: (data || []).map(publicStoryListItem),
    })
  } catch (error) {
    console.error('GET PUBLIC SHADOW EXCLUSIVE STORIES ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load Shadow Exclusive stories',
      error: error.message,
    })
  }
}

export async function getPublicStoryById(req, res) {
  try {
    const { storyId } = req.params

    const story = await getPublishedReadableStory(storyId)

    if (!story) {
      return res.status(404).json({
        ok: false,
        message: 'Story not found',
      })
    }

    if (story.is_shadow_exclusive && story.exclusive_status !== 'approved') {
      return res.status(404).json({
        ok: false,
        message: 'Story not found',
      })
    }

    const [{ data: slides, error: slidesError }, authorPage] = await Promise.all([
      supabase
        .from('story_carousel_slides')
        .select('*')
        .eq('story_id', storyId)
        .eq('is_active', true)
        .order('sort_order', { ascending: true }),
      getAuthorPageById(story.author_id),
    ])

    if (slidesError) throw slidesError

    return res.status(200).json({
      ok: true,
      story: publicStory(story, slides || [], authorPage),
    })
  } catch (error) {
    console.error('GET PUBLIC STORY ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load story',
      error: error.message,
    })
  }
}

export async function getPublicShadowExclusiveStoryById(req, res) {
  try {
    const { storyId } = req.params

    const story = await getApprovedExclusiveStory(storyId)

    if (!story) {
      return res.status(404).json({
        ok: false,
        message: 'Shadow Exclusive story not found',
      })
    }

    const [{ data: slides, error: slidesError }, authorPage] = await Promise.all([
      supabase
        .from('story_carousel_slides')
        .select('*')
        .eq('story_id', storyId)
        .eq('is_active', true)
        .order('sort_order', { ascending: true }),
      getAuthorPageById(story.author_id),
    ])

    if (slidesError) throw slidesError

    return res.status(200).json({
      ok: true,
      story: publicStory(story, slides || [], authorPage),
    })
  } catch (error) {
    console.error('GET PUBLIC SHADOW EXCLUSIVE STORY ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load Shadow Exclusive story',
      error: error.message,
    })
  }
}

export async function getPublicStoryEpisodes(req, res) {
  try {
    const { storyId } = req.params

    const story = await getPublishedReadableStory(storyId)

    if (!story) {
      return res.status(404).json({
        ok: false,
        message: 'Story not found',
      })
    }

    if (story.is_shadow_exclusive && story.exclusive_status !== 'approved') {
      return res.status(404).json({
        ok: false,
        message: 'Story not found',
      })
    }

    const { data, error } = await supabase
      .from('episodes')
      .select('id, story_id, title, cover_url, is_adult, is_locked, unlock_methods, status, episode_number, character_count, published_at, created_at, updated_at')
      .eq('story_id', storyId)
      .eq('status', 'published')
      .order('episode_number', { ascending: true })

    if (error) throw error

    return res.status(200).json({
      ok: true,
      episodes: (data || []).map(publicEpisodeListItem),
    })
  } catch (error) {
    console.error('GET PUBLIC STORY EPISODES ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load episodes',
      error: error.message,
    })
  }
}

export async function getPublicEpisodeById(req, res) {
  try {
    const { storyId, episodeId } = req.params

    const story = await getPublishedReadableStory(storyId)

    if (!story) {
      return res.status(404).json({
        ok: false,
        message: 'Story not found',
      })
    }

    if (story.is_shadow_exclusive && story.exclusive_status !== 'approved') {
      return res.status(404).json({
        ok: false,
        message: 'Story not found',
      })
    }

    const { data: episode, error } = await supabase
      .from('episodes')
      .select('*')
      .eq('id', episodeId)
      .eq('story_id', storyId)
      .eq('status', 'published')
      .maybeSingle()

    if (error) throw error

    if (!episode) {
      return res.status(404).json({
        ok: false,
        message: 'Episode not found',
      })
    }

    const userId = getOptionalUserId(req)
    const freeEpisode = isEpisodeFreeForReader(episode)
    const unlocked = freeEpisode || await hasActiveEpisodeUnlock({ userId, episodeId })

    if (!unlocked) {
      return res.status(423).json({
        ok: false,
        code: 'EPISODE_LOCKED',
        message: 'This episode is locked',
        locked: true,
        story: publicStory(story),
        episode: {
          ...publicEpisodeListItem(episode),
          content: '',
        },
      })
    }

    return res.status(200).json({
      ok: true,
      locked: false,
      story: publicStory(story),
      episode: publicEpisode(episode),
    })
  } catch (error) {
    console.error('GET PUBLIC EPISODE ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load episode',
      error: error.message,
    })
  }
}
  try {
    const { storyId, episodeId } = req.params

    const story = await getPublishedReadableStory(storyId)

    if (!story) {
      return res.status(404).json({
        ok: false,
        message: 'Story not found',
      })
    }

    if (story.is_shadow_exclusive && story.exclusive_status !== 'approved') {
      return res.status(404).json({
        ok: false,
        message: 'Story not found',
      })
    }

    const { data: episode, error } = await supabase
      .from('episodes')
      .select('*')
      .eq('id', episodeId)
      .eq('story_id', storyId)
      .eq('status', 'published')
      .maybeSingle()

    if (error) throw error

    if (!episode) {
      return res.status(404).json({
        ok: false,
        message: 'Episode not found',
      })
    }

    return res.status(200).json({
      ok: true,
      story: publicStory(story),
      episode: publicEpisode(episode),
    })
  } catch (error) {
    console.error('GET PUBLIC EPISODE ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load episode',
      error: error.message,
    })
  }
}
