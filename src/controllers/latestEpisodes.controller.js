import { supabase } from '../config/supabase.js'

function normalizeLimit(value, fallback = 10, max = 30) {
  const number = Number(value)

  if (!Number.isFinite(number) || number <= 0) return fallback

  return Math.min(Math.floor(number), max)
}

function getPublishedTime(episode) {
  const value = episode?.published_at || episode?.created_at
  const time = value ? new Date(value).getTime() : 0

  return Number.isFinite(time) ? time : 0
}

function isPublicStory(story) {
  if (!story || story.status !== 'published') return false

  if (story.is_shadow_exclusive) {
    return story.exclusive_status === 'approved'
  }

  return true
}

function publicAuthorPage(page) {
  if (!page) return null

  return {
    id: page.id,
    page_name: page.page_name,
    page_username: page.page_username,
    avatar_url: page.avatar_url || '',
  }
}

function publicStory(story, authorPage) {
  return {
    id: story.id,
    title: story.title,
    main_genre: story.main_genre,
    story_language: story.story_language,
    story_status: story.story_status || 'New',
    cover_url: story.cover_url || '',
    landscape_thumbnail_url: story.landscape_thumbnail_url || '',
    is_adult: Boolean(story.is_adult),
    is_shadow_exclusive: Boolean(story.is_shadow_exclusive),
    total_episodes: Number(story.total_episodes || 0),
    total_views: Number(story.total_views || 0),
    author_page: publicAuthorPage(authorPage),
  }
}

function publicEpisode(episode, story, authorPage) {
  const publishedTime = episode.published_at || episode.created_at

  return {
    id: episode.id,
    story_id: episode.story_id,
    title: episode.title,
    episode_number: Number(episode.episode_number || 0),
    cover_url:
      episode.cover_url ||
      story.landscape_thumbnail_url ||
      story.cover_url ||
      '',
    is_adult: Boolean(episode.is_adult || story.is_adult),
    is_locked: Boolean(episode.is_locked),
    unlock_methods: episode.unlock_methods || [],
    character_count: Number(episode.character_count || 0),
    total_views: Number(episode.total_views || 0),
    published_at: episode.published_at,
    created_at: episode.created_at,
    updated_at: episode.updated_at,
    published_time: publishedTime,
    reader_path: `/story/${story.id}/episode/${episode.id}`,
    story_path: `/story/${story.id}`,
    story: publicStory(story, authorPage),
  }
}

export async function getLatestPublicEpisodes(req, res) {
  try {
    const limit = normalizeLimit(req.query.limit)
    const queryLimit = Math.min(limit * 4, 120)
    const now = new Date().toISOString()
    const fields =
      'id, story_id, title, cover_url, is_adult, is_locked, unlock_methods, status, episode_number, character_count, total_views, published_at, created_at, updated_at'

    const [
      { data: scheduledEpisodes, error: scheduledError },
      { data: legacyEpisodes, error: legacyError },
    ] = await Promise.all([
      supabase
        .from('episodes')
        .select(fields)
        .eq('status', 'published')
        .is('deleted_at', null)
        .not('published_at', 'is', null)
        .lte('published_at', now)
        .order('published_at', { ascending: false })
        .limit(queryLimit),
      supabase
        .from('episodes')
        .select(fields)
        .eq('status', 'published')
        .is('deleted_at', null)
        .is('published_at', null)
        .lte('created_at', now)
        .order('created_at', { ascending: false })
        .limit(queryLimit),
    ])

    if (scheduledError) throw scheduledError
    if (legacyError) throw legacyError

    const episodeById = new Map()

    for (const episode of [...(scheduledEpisodes || []), ...(legacyEpisodes || [])]) {
      episodeById.set(episode.id, episode)
    }

    const episodes = [...episodeById.values()].sort(
      (a, b) => getPublishedTime(b) - getPublishedTime(a)
    )

    const storyIds = [...new Set(episodes.map((episode) => episode.story_id).filter(Boolean))]

    if (!storyIds.length) {
      return res.status(200).json({
        ok: true,
        episodes: [],
      })
    }

    const { data: storyRows, error: storiesError } = await supabase
      .from('stories')
      .select(
        'id, author_id, user_id, title, main_genre, story_language, story_status, cover_url, landscape_thumbnail_url, is_adult, status, is_shadow_exclusive, exclusive_status, total_episodes, total_views, updated_at'
      )
      .in('id', storyIds)
      .eq('status', 'published')
      .is('deleted_at', null)

    if (storiesError) throw storiesError

    const stories = (storyRows || []).filter(isPublicStory)
    const storyById = new Map(stories.map((story) => [story.id, story]))
    const authorIds = [...new Set(stories.map((story) => story.author_id).filter(Boolean))]

    let authorPages = []

    if (authorIds.length) {
      const { data, error } = await supabase
        .from('author_pages')
        .select('id, page_name, page_username, avatar_url, status')
        .in('id', authorIds)
        .eq('status', 'active')

      if (error) throw error

      authorPages = data || []
    }

    const authorPageById = new Map(
      authorPages.map((page) => [String(page.id), page])
    )

    const latestEpisodes = episodes
      .filter((episode) => storyById.has(episode.story_id))
      .slice(0, limit)
      .map((episode) => {
        const story = storyById.get(episode.story_id)
        const authorPage = authorPageById.get(String(story.author_id)) || null

        return publicEpisode(episode, story, authorPage)
      })

    return res.status(200).json({
      ok: true,
      episodes: latestEpisodes,
    })
  } catch (error) {
    console.error('GET LATEST PUBLIC EPISODES ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load latest episodes',
      error: error.message,
    })
  }
}
