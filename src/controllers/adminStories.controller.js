import { supabase } from '../config/supabase.js'
import { createAuthorStoryNotificationSafely } from '../services/authorStoryNotifications.service.js'

const PAGE_SIZE_DEFAULT = 20
const PAGE_SIZE_MAX = 100
const STORY_VISIBILITY_STATUSES = ['active', 'restricted', 'disabled']
const AUTHOR_ADMIN_STATUSES = ['active', 'disabled']

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

function adminActor(req) {
  return cleanText(req.admin?.email || req.admin?.username || req.admin?.admin_name || req.admin?.user_id || req.headers['x-admin-name'] || req.headers['x-admin-actor'] || 'Admin')
}


async function createStoryAdminNotificationSafely({
  story,
  action,
  title,
  message = '',
  actor = '',
}) {
  if (!story?.id || !story?.author_id) return null

  return createAuthorStoryNotificationSafely({
    authorId: story.author_id,
    type: 'system',
    title,
    message,
    targetUrl: `/author/story/${story.id}/manage`,
    sourceKey: `admin-story:${action}:${story.id}:${story.updated_at || Date.now()}`,
    metadata: {
      story_id: story.id,
      action,
      admin_visibility_status: story.admin_visibility_status || '',
      admin_actor: actor,
    },
  })
}

async function createAuthorAdminNotificationSafely({
  author,
  action,
  title,
  message = '',
  actor = '',
}) {
  if (!author?.id) return null

  return createAuthorStoryNotificationSafely({
    authorId: author.id,
    authorUserId: author.user_id || '',
    type: 'system',
    title,
    message,
    targetUrl: '/author/dashboard',
    sourceKey: `admin-author:${action}:${author.id}:${author.updated_at || Date.now()}`,
    metadata: {
      author_id: author.id,
      action,
      admin_status: author.admin_status || '',
      admin_actor: actor,
    },
  })
}

function daysLeft(value) {
  if (!value) return null
  const time = new Date(value).getTime()
  if (Number.isNaN(time)) return null
  return Math.max(0, Math.ceil((time - Date.now()) / 86400000))
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
    admin_disabled_reason: author.admin_disabled_reason || '',
    admin_disabled_at: author.admin_disabled_at || null,
    policy_warning_count: Number(author.policy_warning_count || 0),
    total_stories: Number(author.total_stories || 0),
    total_followers: Number(author.total_followers || 0),
    created_at: author.created_at,
    updated_at: author.updated_at,
  }
}

function publicStory(story, author = null) {
  if (!story) return null

  return {
    id: story.id,
    author_id: story.author_id,
    user_id: story.user_id,
    title: story.title,
    story_type: story.story_type || 'novel',
    story_language: story.story_language,
    main_genre: story.main_genre,
    story_status: story.story_status || 'New',
    tags: story.tags || [],
    description: story.description,
    is_adult: Boolean(story.is_adult),
    cover_url: story.cover_url,
    status: story.status,
    access_type: story.access_type || 'free',
    is_shadow_exclusive: Boolean(story.is_shadow_exclusive),
    exclusive_status: story.exclusive_status || 'none',
    exclusive_sections: story.exclusive_sections || [],
    update_days: story.update_days || [],
    total_episodes: Number(story.total_episodes || 0),
    total_views: Number(story.total_views || 0),
    total_likes: Number(story.total_likes || 0),
    total_comments: Number(story.total_comments || 0),
    deleted_at: story.deleted_at || null,
    delete_expires_at: story.delete_expires_at || null,
    admin_archive_expires_at: story.admin_archive_expires_at || null,
    deleted_by_user_id: story.deleted_by_user_id || null,
    author_restore_days_left: daysLeft(story.delete_expires_at),
    admin_archive_days_left: daysLeft(story.admin_archive_expires_at),
    admin_visibility_status: story.admin_visibility_status || 'active',
    admin_restriction_reason: story.admin_restriction_reason || '',
    admin_restricted_at: story.admin_restricted_at || null,
    admin_restricted_by: story.admin_restricted_by || '',
    policy_warning_count: Number(story.policy_warning_count || 0),
    last_policy_warning_at: story.last_policy_warning_at || null,
    admin_note: story.admin_note || '',
    author_page: publicAuthor(author),
    created_at: story.created_at,
    updated_at: story.updated_at,
  }
}

function extractStoryIdFromPickerQuery(value) {
  const text = cleanText(value)

  if (!text) return ''
  if (isUuid(text)) return text

  let decodedText = text

  try {
    decodedText = decodeURIComponent(text)
  } catch {
    decodedText = text
  }

  const uuidPattern =
    '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'

  const patterns = [
    new RegExp(
      `(?:^|/)author/story/(${uuidPattern})(?:/|$|[?#])`,
      'i'
    ),
    new RegExp(
      `(?:^|/)story/(${uuidPattern})(?:/|$|[?#])`,
      'i'
    ),
  ]

  for (const pattern of patterns) {
    const match = decodedText.match(pattern)

    if (match?.[1] && isUuid(match[1])) {
      return match[1]
    }
  }

  return ''
}

function normalizeStoryPickerSearch(value) {
  return cleanText(value)
    .replace(/[(),]/g, ' ')
    .replace(/[%_]/g, '\\$&')
    .replace(/\s+/g, ' ')
    .trim()
}

function publicStoryPickerItem(story, author = null) {
  if (!story) return null

  return {
    id: story.id,
    title: story.title || '',
    cover_url: story.cover_url || '',
    story_type: story.story_type || 'novel',
    story_language: story.story_language || '',
    story_status: story.story_status || 'New',
    total_episodes: Number(
      story.total_episodes || 0
    ),
    updated_at: story.updated_at || null,
    story_url: `/story/${story.id}`,
    author_page: author
      ? {
          id: author.id,
          page_name: author.page_name || '',
          page_username:
            author.page_username || '',
          avatar_url: author.avatar_url || '',
        }
      : null,
  }
}

function extractStorySlides(story) {
  const possibleSlides = story?.slides || story?.slide_urls || story?.story_slides || story?.images

  if (Array.isArray(possibleSlides)) {
    return possibleSlides
      .map((item, index) => {
        if (typeof item === 'string') {
          return { id: `slide-${index + 1}`, image_url: item, order_index: index + 1 }
        }

        return {
          id: item.id || `slide-${index + 1}`,
          image_url: item.image_url || item.slide_url || item.url || item.cover_url || '',
          order_index: item.order_index || item.sort_order || index + 1,
        }
      })
      .filter((item) => item.image_url)
      .slice(0, 5)
  }

  return [
    story?.slide_1_url ? { id: 'slide-1', image_url: story.slide_1_url, order_index: 1 } : null,
    story?.slide_2_url ? { id: 'slide-2', image_url: story.slide_2_url, order_index: 2 } : null,
    story?.slide_3_url ? { id: 'slide-3', image_url: story.slide_3_url, order_index: 3 } : null,
    story?.slide_4_url ? { id: 'slide-4', image_url: story.slide_4_url, order_index: 4 } : null,
    story?.slide_5_url ? { id: 'slide-5', image_url: story.slide_5_url, order_index: 5 } : null,
  ].filter(Boolean)
}

async function fetchAuthors(authorIds) {
  const ids = [...new Set((authorIds || []).filter(Boolean))]
  if (!ids.length) return new Map()

  const { data, error } = await supabase
    .from('author_pages')
    .select('*')
    .in('id', ids)

  if (error) throw error

  return new Map((data || []).map((author) => [author.id, author]))
}

async function countStories(builder) {
  const { count, error } = await builder.select('id', { count: 'exact', head: true })
  if (error) throw error
  return count || 0
}

export async function getAdminStoriesOverview(req, res) {
  try {
    const { data: stories, error: storiesError } = await supabase
      .from('stories')
      .select('id, deleted_at, admin_visibility_status, policy_warning_count')

    if (storiesError) throw storiesError

    const { data: authors, error: authorsError } = await supabase
      .from('author_pages')
      .select('id, admin_status')

    const storyRows = stories || []
    const authorRows = authorsError ? [] : authors || []

    const totalStories = storyRows.length
    const activeStories = storyRows.filter((story) => !story.deleted_at).length
    const deletedStories = storyRows.filter((story) => story.deleted_at).length
    const restrictedStories = storyRows.filter((story) => story.admin_visibility_status === 'restricted').length
    const disabledStories = storyRows.filter((story) => story.admin_visibility_status === 'disabled').length
    const warnedStories = storyRows.filter((story) => Number(story.policy_warning_count || 0) > 0).length
    const disabledAuthors = authorRows.filter((author) => author.admin_status === 'disabled').length

    return res.status(200).json({
      ok: true,
      summary: {
        total_stories: totalStories,
        active_stories: activeStories,
        deleted_by_authors: deletedStories,
        restricted_stories: restrictedStories,
        disabled_stories: disabledStories,
        warned_stories: warnedStories,
        disabled_authors: disabledAuthors,
      },
    })
  } catch (error) {
    console.error('GET ADMIN STORIES OVERVIEW ERROR:', error)
    return res.status(500).json({
      ok: false,
      message: 'Failed to load stories overview',
      error: error.message,
    })
  }
}

const CAMBODIA_UTC_OFFSET_MS = 7 * 60 * 60 * 1000
const ACTIVITY_PERIODS = ['today', 'week', 'month']
const ACTIVITY_SORTS = ['episodes', 'consistency', 'latest']

function normalizeActivityPeriod(value) {
  const period = cleanText(value || 'today').toLowerCase()
  return ACTIVITY_PERIODS.includes(period) ? period : 'today'
}

function normalizeActivityOffset(value) {
  const offset = Number(value)
  if (!Number.isFinite(offset)) return 0
  return Math.max(-120, Math.min(0, Math.floor(offset)))
}

function getCambodiaPeriodRange(period, offset) {
  const localNow = new Date(Date.now() + CAMBODIA_UTC_OFFSET_MS)
  const year = localNow.getUTCFullYear()
  const month = localNow.getUTCMonth()
  const date = localNow.getUTCDate()
  let startLocal
  let endLocal

  if (period === 'month') {
    startLocal = Date.UTC(year, month + offset, 1)
    endLocal = Date.UTC(year, month + offset + 1, 1)
  } else if (period === 'week') {
    const mondayOffset = (localNow.getUTCDay() + 6) % 7
    startLocal = Date.UTC(year, month, date - mondayOffset + offset * 7)
    endLocal = startLocal + 7 * 86400000
  } else {
    startLocal = Date.UTC(year, month, date + offset)
    endLocal = startLocal + 86400000
  }

  return {
    start: new Date(startLocal - CAMBODIA_UTC_OFFSET_MS).toISOString(),
    end: new Date(endLocal - CAMBODIA_UTC_OFFSET_MS).toISOString(),
  }
}

function getCambodiaDayKey(value) {
  const time = new Date(value).getTime()
  if (Number.isNaN(time)) return ''
  return new Date(time + CAMBODIA_UTC_OFFSET_MS).toISOString().slice(0, 10)
}

function compareActivityAuthors(sort) {
  return (a, b) => {
    if (sort === 'consistency') {
      return b.active_days - a.active_days || b.new_episodes - a.new_episodes || new Date(b.last_update) - new Date(a.last_update)
    }

    if (sort === 'latest') {
      return new Date(b.last_update) - new Date(a.last_update) || b.new_episodes - a.new_episodes || b.active_days - a.active_days
    }

    return b.new_episodes - a.new_episodes || b.active_days - a.active_days || new Date(b.last_update) - new Date(a.last_update)
  }
}

export async function getAdminStoryUpdateActivity(req, res) {
  try {
    const period = normalizeActivityPeriod(req.query.period)
    const offset = normalizeActivityOffset(req.query.offset)
    const sortValue = cleanText(req.query.sort || 'episodes').toLowerCase()
    const sort = ACTIVITY_SORTS.includes(sortValue) ? sortValue : 'episodes'
    const page = normalizePage(req.query.page)
    const limit = normalizeLimit(req.query.limit)
    const search = cleanText(req.query.q || req.query.search).toLowerCase()
    const storyType = cleanText(req.query.story_type || req.query.storyType || 'all').toLowerCase()
    const language = cleanText(req.query.language || 'all').toLowerCase()
    const genre = cleanText(req.query.genre || 'all').toLowerCase()
    const range = getCambodiaPeriodRange(period, offset)

    const { data: episodeRows, error: episodeError } = await supabase
      .from('episodes')
      .select('id, story_id, author_id, title, episode_number, first_published_at')
      .eq('status', 'published')
      .is('deleted_at', null)
      .gte('first_published_at', range.start)
      .lt('first_published_at', range.end)
      .order('first_published_at', { ascending: false })

    if (episodeError) throw episodeError

    const rawEpisodes = episodeRows || []
    const storyIds = [...new Set(rawEpisodes.map((episode) => episode.story_id).filter(Boolean))]

    if (!storyIds.length) {
      return res.status(200).json({
        ok: true,
        period: { key: period, offset, ...range, timezone: 'Asia/Phnom_Penh' },
        summary: { active_authors: 0, updated_stories: 0, new_episodes: 0, top_author: null },
        authors: [],
        filter_options: { story_types: [], languages: [], genres: [] },
        page: 1,
        limit,
        total: 0,
        total_pages: 1,
        has_next: false,
        has_prev: false,
      })
    }

    const { data: storyRows, error: storyError } = await supabase
      .from('stories')
      .select('id, author_id, title, cover_url, story_type, story_language, main_genre, admin_visibility_status, deleted_at')
      .in('id', storyIds)
      .is('deleted_at', null)

    if (storyError) throw storyError

    const stories = storyRows || []
    const storyMap = new Map(stories.map((story) => [story.id, story]))
    const authors = await fetchAuthors(stories.map((story) => story.author_id))
    const filterOptions = {
      story_types: [...new Set(stories.map((story) => story.story_type).filter(Boolean))].sort(),
      languages: [...new Set(stories.map((story) => story.story_language).filter(Boolean))].sort(),
      genres: [...new Set(stories.map((story) => story.main_genre).filter(Boolean))].sort(),
    }

    const filteredEpisodes = rawEpisodes.filter((episode) => {
      const story = storyMap.get(episode.story_id)
      const author = authors.get(story?.author_id || episode.author_id)
      if (!story || !author) return false
      if (storyType !== 'all' && String(story.story_type || '').toLowerCase() !== storyType) return false
      if (language !== 'all' && String(story.story_language || '').toLowerCase() !== language) return false
      if (genre !== 'all' && String(story.main_genre || '').toLowerCase() !== genre) return false
      if (!search) return true

      const searchText = [
        author.page_name,
        author.page_username,
        story.title,
        story.id,
        episode.title,
      ].map((value) => String(value || '').toLowerCase()).join(' ')

      return searchText.includes(search)
    })

    const authorActivity = new Map()

    filteredEpisodes.forEach((episode) => {
      const story = storyMap.get(episode.story_id)
      const author = authors.get(story.author_id)
      const publishedAt = episode.first_published_at
      let activity = authorActivity.get(author.id)

      if (!activity) {
        activity = {
          author: publicAuthor(author),
          new_episodes: 0,
          active_day_keys: new Set(),
          story_map: new Map(),
          last_update: publishedAt,
        }
        authorActivity.set(author.id, activity)
      }

      activity.new_episodes += 1
      activity.active_day_keys.add(getCambodiaDayKey(publishedAt))
      if (new Date(publishedAt) > new Date(activity.last_update)) activity.last_update = publishedAt

      let storyActivity = activity.story_map.get(story.id)
      if (!storyActivity) {
        storyActivity = {
          id: story.id,
          title: story.title,
          cover_url: story.cover_url || null,
          story_type: story.story_type || 'novel',
          story_language: story.story_language || '',
          main_genre: story.main_genre || '',
          admin_visibility_status: story.admin_visibility_status || 'active',
          new_episodes: 0,
          last_update: publishedAt,
          latest_episode: null,
        }
        activity.story_map.set(story.id, storyActivity)
      }

      storyActivity.new_episodes += 1
      if (!storyActivity.latest_episode || new Date(publishedAt) > new Date(storyActivity.last_update)) {
        storyActivity.last_update = publishedAt
        storyActivity.latest_episode = {
          id: episode.id,
          title: episode.title,
          episode_number: Number(episode.episode_number || 0),
          first_published_at: publishedAt,
        }
      }
    })

    const activityRows = [...authorActivity.values()].map((activity) => ({
      author: activity.author,
      stories_updated: activity.story_map.size,
      new_episodes: activity.new_episodes,
      active_days: [...activity.active_day_keys].filter(Boolean).length,
      last_update: activity.last_update,
      stories: [...activity.story_map.values()].sort((a, b) => new Date(b.last_update) - new Date(a.last_update)),
    }))

    const topAuthor = [...activityRows].sort(compareActivityAuthors('episodes'))[0] || null
    activityRows.sort(compareActivityAuthors(sort))

    const updatedStoryIds = new Set(filteredEpisodes.map((episode) => episode.story_id))
    const total = activityRows.length
    const totalPages = Math.max(1, Math.ceil(total / limit))
    const safePage = Math.min(page, totalPages)
    const from = (safePage - 1) * limit
    const pagedAuthors = activityRows.slice(from, from + limit).map((activity, index) => ({
      rank: from + index + 1,
      ...activity,
    }))

    return res.status(200).json({
      ok: true,
      period: { key: period, offset, ...range, timezone: 'Asia/Phnom_Penh' },
      summary: {
        active_authors: total,
        updated_stories: updatedStoryIds.size,
        new_episodes: filteredEpisodes.length,
        top_author: topAuthor ? {
          author: topAuthor.author,
          new_episodes: topAuthor.new_episodes,
          active_days: topAuthor.active_days,
        } : null,
      },
      authors: pagedAuthors,
      filter_options: filterOptions,
      page: safePage,
      limit,
      total,
      total_pages: totalPages,
      has_next: safePage < totalPages,
      has_prev: safePage > 1,
    })
  } catch (error) {
    console.error('GET ADMIN STORY UPDATE ACTIVITY ERROR:', error)
    return res.status(500).json({
      ok: false,
      message: 'Failed to load story update activity',
      error: error.message,
    })
  }
}

export async function getAdminStoryPicker(
  req,
  res
) {
  try {
    const page = normalizePage(req.query.page)
    const limit = Math.min(
      normalizeLimit(req.query.limit),
      20
    )
    const from = (page - 1) * limit
    const to = from + limit - 1

    const search = cleanText(
      req.query.q ||
        req.query.search ||
        req.query.keyword
    )

    const exactStoryId =
      extractStoryIdFromPickerQuery(search)

    let query = supabase
      .from('stories')
      .select(
        [
          'id',
          'author_id',
          'title',
          'cover_url',
          'story_type',
          'story_language',
          'story_status',
          'total_episodes',
          'updated_at',
        ].join(','),
        {
          count: 'exact',
        }
      )
      .eq('status', 'published')
      .eq('admin_visibility_status', 'active')
      .is('deleted_at', null)

    let queryType = 'recent'

    if (exactStoryId) {
      query = query.eq('id', exactStoryId)
      queryType = 'exact_story'
    } else if (search) {
      const searchText =
        normalizeStoryPickerSearch(search)

      if (!searchText) {
        return res.status(200).json({
          ok: true,
          stories: [],
          page: 1,
          limit,
          total: 0,
          total_pages: 1,
          has_next: false,
          has_prev: false,
          query_type: 'search',
        })
      }

      const authorSearchText =
        searchText.replace(/^@/, '')

      let authorIds = []

      if (authorSearchText) {
        const {
          data: matchedAuthors,
          error: authorSearchError,
        } = await supabase
          .from('author_pages')
          .select('id')
          .or(
            [
              `page_name.ilike.%${authorSearchText}%`,
              `page_username.ilike.%${authorSearchText}%`,
            ].join(',')
          )
          .limit(100)

        if (authorSearchError) {
          throw authorSearchError
        }

        authorIds = [
          ...new Set(
            (matchedAuthors || [])
              .map((author) => author.id)
              .filter(Boolean)
          ),
        ]
      }

      const searchFilters = [
        `title.ilike.%${searchText}%`,
      ]

      if (authorIds.length) {
        searchFilters.push(
          `author_id.in.(${authorIds.join(',')})`
        )
      }

      query = query.or(searchFilters.join(','))
      queryType = 'search'
    }

    const {
      data,
      count,
      error,
    } = await query
      .order('updated_at', {
        ascending: false,
        nullsFirst: false,
      })
      .range(from, to)

    if (error) throw error

    const authors = await fetchAuthors(
      (data || []).map(
        (story) => story.author_id
      )
    )

    const stories = (data || [])
      .map((story) =>
        publicStoryPickerItem(
          story,
          authors.get(story.author_id)
        )
      )
      .filter(Boolean)

    const total = Number(count || 0)
    const totalPages = Math.max(
      1,
      Math.ceil(total / limit)
    )

    return res.status(200).json({
      ok: true,
      stories,
      page,
      limit,
      total,
      total_pages: totalPages,
      has_next: page < totalPages,
      has_prev: page > 1,
      query_type: queryType,
    })
  } catch (error) {
    console.error(
      'GET ADMIN STORY PICKER ERROR:',
      error
    )

    return res.status(500).json({
      ok: false,
      message:
        'Failed to search published stories',
      error: error.message,
    })
  }
}


export async function getAdminStories(req, res) {
  try {
    const page = normalizePage(req.query.page)
    const limit = normalizeLimit(req.query.limit)
    const from = (page - 1) * limit
    const to = from + limit - 1
    const tab = cleanText(req.query.tab || 'active').toLowerCase()
    const search = cleanText(req.query.q || req.query.search || req.query.keyword)
    const storyStatus = cleanText(req.query.status || 'all').toLowerCase()
    const visibility = cleanText(req.query.visibility || 'all').toLowerCase()
    const genre = cleanText(req.query.genre || 'all')
    const authorId = cleanText(req.query.author_id || req.query.authorId)

    let query = supabase.from('stories').select('*', { count: 'exact' })

    if (tab === 'deleted') query = query.not('deleted_at', 'is', null)
    if (tab === 'active') query = query.is('deleted_at', null)
    if (tab === 'restricted') query = query.in('admin_visibility_status', ['restricted', 'disabled']).is('deleted_at', null)
    if (tab === 'warnings') query = query.gt('policy_warning_count', 0)

    if (storyStatus !== 'all') query = query.eq('status', storyStatus)
    if (visibility !== 'all') query = query.eq('admin_visibility_status', visibility)
    if (genre !== 'all') query = query.eq('main_genre', genre)
    if (authorId) query = query.eq('author_id', authorId)

    if (search) {
      if (isUuid(search)) {
        query = query.eq('id', search)
      } else {
        const safeSearch = search.replace(/[%_]/g, '\\$&')
        query = query.or(`title.ilike.%${safeSearch}%,main_genre.ilike.%${safeSearch}%,story_language.ilike.%${safeSearch}%`)
      }
    }

    const { data, count, error } = await query
      .order(tab === 'deleted' ? 'deleted_at' : 'updated_at', { ascending: false, nullsFirst: false })
      .range(from, to)

    if (error) throw error

    const authors = await fetchAuthors((data || []).map((story) => story.author_id))
    const stories = (data || []).map((story) => publicStory(story, authors.get(story.author_id)))
    const total = count || 0
    const totalPages = Math.max(1, Math.ceil(total / limit))

    return res.status(200).json({
      ok: true,
      stories,
      page,
      limit,
      total,
      total_pages: totalPages,
      has_next: page < totalPages,
      has_prev: page > 1,
    })
  } catch (error) {
    console.error('GET ADMIN STORIES ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to load stories', error: error.message })
  }
}

export async function getAdminStoryById(req, res) {
  try {
    const { storyId } = req.params

    const { data: story, error: storyError } = await supabase
      .from('stories')
      .select('*')
      .eq('id', storyId)
      .maybeSingle()

    if (storyError) throw storyError
    if (!story) return res.status(404).json({ ok: false, message: 'Story not found' })

    const [{ data: episodes, error: episodesError }, { data: logs, error: logsError }, { data: slides, error: slidesError }, authors] = await Promise.all([
      supabase
.from('episodes')
.select('id, story_id, title, content, status, episode_number, character_count, word_count, total_likes, total_views, published_at, scheduled_at, deleted_at, delete_expires_at, created_at, updated_at')
.eq('story_id', storyId)
.order('episode_number', { ascending: true }),
      supabase
        .from('story_moderation_logs')
        .select('*')
        .eq('story_id', storyId)
        .order('created_at', { ascending: false })
        .limit(50),
      supabase
        .from('story_carousel_slides')
        .select('*')
        .eq('story_id', storyId)
        .order('sort_order', { ascending: true })
        .limit(5),
      fetchAuthors([story.author_id]),
    ])

    if (episodesError) throw episodesError
    if (logsError) throw logsError
    if (slidesError) throw slidesError

    const episodeIds = (episodes || [])
      .map((episode) => episode.id)
      .filter(Boolean)

    let episodePages = []

    if (episodeIds.length) {
      const { data, error } = await supabase
        .from('episode_pages')
        .select('id, episode_id, story_id, image_url, sort_order, width, height')
        .in('episode_id', episodeIds)
        .order('sort_order', { ascending: true })

      if (error) throw error
      episodePages = data || []
    }

    const pagesByEpisode = new Map()

    episodePages.forEach((page) => {
      const pages = pagesByEpisode.get(page.episode_id) || []
      pages.push(page)
      pagesByEpisode.set(page.episode_id, pages)
    })

    const adminEpisodes = (episodes || []).map((episode) => ({
      ...episode,
      pages: pagesByEpisode.get(episode.id) || [],
    }))

    const storySlides = slides || []
    const storyData = publicStory(story, authors.get(story.author_id))

    return res.status(200).json({
      ok: true,
      story: {
        ...storyData,
        slides: storySlides,
      },
      slides: storySlides,
      episodes: adminEpisodes,
      moderation_logs: logs || [],
    })
  } catch (error) {
    console.error('GET ADMIN STORY BY ID ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to load story details', error: error.message })
  }
}

export async function updateStoryAdminVisibility(req, res) {
  try {
    const { storyId } = req.params
    const visibility = cleanText(req.body.visibility || req.body.admin_visibility_status).toLowerCase()
    const reason = cleanText(req.body.reason || req.body.admin_restriction_reason)
    const note = cleanText(req.body.admin_note || req.body.note)
    const actor = adminActor(req)

    if (!STORY_VISIBILITY_STATUSES.includes(visibility)) {
      return res.status(400).json({ ok: false, message: 'Invalid story visibility status' })
    }

    if (visibility !== 'active' && reason.length < 5) {
      return res.status(400).json({ ok: false, message: 'Restriction reason is required' })
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
      admin_visibility_status: visibility,
      admin_restriction_reason: visibility === 'active' ? '' : reason,
      admin_restricted_at: visibility === 'active' ? null : now,
      admin_restricted_by: visibility === 'active' ? '' : actor,
      admin_note: note || oldStory.admin_note || '',
      updated_at: now,
    }

    const { data: story, error: updateError } = await supabase
      .from('stories')
      .update(updatePayload)
      .eq('id', storyId)
      .select()
      .single()

    if (updateError) throw updateError

    await supabase.from('story_moderation_logs').insert({
      story_id: storyId,
      author_id: story.author_id,
      action: visibility === 'active' ? 'restriction_removed' : `story_${visibility}`,
      reason: visibility === 'active' ? 'Story restriction removed by admin' : reason,
      admin_actor: actor,
    })

    await createStoryAdminNotificationSafely({
      story,
      action: visibility === 'active' ? 'restriction_removed' : `story_${visibility}`,
      title:
        visibility === 'active'
          ? `Admin restored ${story.title || 'your story'}`
          : visibility === 'restricted'
            ? `Admin restricted ${story.title || 'your story'}`
            : `Admin disabled ${story.title || 'your story'}`,
      message:
        visibility === 'active'
          ? note || 'Your story is active again.'
          : reason,
      actor,
    })

    const authors = await fetchAuthors([story.author_id])

    return res.status(200).json({
      ok: true,
      message: visibility === 'active' ? 'Story restriction removed' : 'Story restriction updated',
      story: publicStory(story, authors.get(story.author_id)),
    })
  } catch (error) {
    console.error('UPDATE STORY ADMIN VISIBILITY ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to update story restriction', error: error.message })
  }
}

export async function issueStoryWarning(req, res) {
  try {
    const { storyId } = req.params
    const reason = cleanText(req.body.reason)
    const note = cleanText(req.body.admin_note || req.body.note)
    const actor = adminActor(req)

    if (reason.length < 5) {
      return res.status(400).json({ ok: false, message: 'Warning reason is required' })
    }

    const { data: oldStory, error: oldStoryError } = await supabase
      .from('stories')
      .select('*')
      .eq('id', storyId)
      .maybeSingle()

    if (oldStoryError) throw oldStoryError
    if (!oldStory) return res.status(404).json({ ok: false, message: 'Story not found' })

    const warningCount = Number(oldStory.policy_warning_count || 0) + 1
    const now = new Date().toISOString()

    const { data: story, error: updateError } = await supabase
      .from('stories')
      .update({
        policy_warning_count: warningCount,
        last_policy_warning_at: now,
        admin_note: note || oldStory.admin_note || '',
        updated_at: now,
      })
      .eq('id', storyId)
      .select()
      .single()

    if (updateError) throw updateError

    await supabase.from('story_moderation_logs').insert({
      story_id: storyId,
      author_id: story.author_id,
      action: 'warning_issued',
      reason,
      admin_actor: actor,
    })

    await createStoryAdminNotificationSafely({
      story,
      action: 'warning_issued',
      title: `Admin issued a warning for ${story.title || 'your story'}`,
      message: reason,
      actor,
    })

    const authors = await fetchAuthors([story.author_id])

    return res.status(200).json({
      ok: true,
      message: 'Warning issued',
      story: publicStory(story, authors.get(story.author_id)),
    })
  } catch (error) {
    console.error('ISSUE STORY WARNING ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to issue warning', error: error.message })
  }
}

export async function updateAuthorAdminStatus(req, res) {
  try {
    const { authorId } = req.params
    const status = cleanText(req.body.status || req.body.admin_status).toLowerCase()
    const reason = cleanText(req.body.reason || req.body.admin_disabled_reason)
    const note = cleanText(req.body.admin_note || req.body.note)
    const actor = adminActor(req)

    if (!AUTHOR_ADMIN_STATUSES.includes(status)) {
      return res.status(400).json({ ok: false, message: 'Invalid author admin status' })
    }

    if (status === 'disabled' && reason.length < 5) {
      return res.status(400).json({ ok: false, message: 'Author disable reason is required' })
    }

    const { data: oldAuthor, error: oldAuthorError } = await supabase
      .from('author_pages')
      .select('*')
      .eq('id', authorId)
      .maybeSingle()

    if (oldAuthorError) throw oldAuthorError
    if (!oldAuthor) return res.status(404).json({ ok: false, message: 'Author page not found' })

    const now = new Date().toISOString()
    const updatePayload = {
      admin_status: status,
      admin_disabled_at: status === 'disabled' ? now : null,
      admin_disabled_by: status === 'disabled' ? actor : '',
      admin_disabled_reason: status === 'disabled' ? reason : '',
      admin_note: note || oldAuthor.admin_note || '',
      updated_at: now,
    }

    if (status === 'disabled') {
      updatePayload.policy_warning_count = Number(oldAuthor.policy_warning_count || 0) + 1
      updatePayload.last_policy_warning_at = now
    }

    const { data: author, error: updateError } = await supabase
      .from('author_pages')
      .update(updatePayload)
      .eq('id', authorId)
      .select()
      .single()

    if (updateError) throw updateError

    await supabase.from('author_moderation_logs').insert({
      author_id: authorId,
      action: status === 'active' ? 'author_page_enabled' : 'author_page_disabled',
      reason: status === 'active' ? 'Author page enabled by admin' : reason,
      admin_actor: actor,
    })

    await createAuthorAdminNotificationSafely({
      author,
      action: status === 'active' ? 'author_page_enabled' : 'author_page_disabled',
      title:
        status === 'active'
          ? 'Admin enabled your Author Page'
          : 'Admin disabled your Author Page',
      message:
        status === 'active'
          ? note || 'Your Author Page is active again.'
          : reason,
      actor,
    })

    return res.status(200).json({
      ok: true,
      message: status === 'active' ? 'Author page enabled' : 'Author page disabled',
      author: publicAuthor(author),
    })
  } catch (error) {
    console.error('UPDATE AUTHOR ADMIN STATUS ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to update author page status', error: error.message })
  }
}

export async function downloadAdminStoryMedia(req, res) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 20000)

  try {
    const { storyId, mediaType, mediaIndex } = req.params
    const type = cleanText(mediaType).toLowerCase()
    const index = Math.max(0, Math.floor(Number(mediaIndex || 0)))

    if (!['cover', 'slide'].includes(type)) {
      return res.status(400).json({ ok: false, message: 'Invalid media type' })
    }

    const { data: story, error: storyError } = await supabase
      .from('stories')
      .select('id, title, cover_url')
      .eq('id', storyId)
      .maybeSingle()

    if (storyError) throw storyError
    if (!story) {
      return res.status(404).json({ ok: false, message: 'Story not found' })
    }

    let mediaUrl = story.cover_url
    let mediaLabel = 'cover'

    if (type === 'slide') {
      const { data: slide, error: slideError } = await supabase
        .from('story_carousel_slides')
        .select('image_url, sort_order')
        .eq('story_id', storyId)
        .order('sort_order', { ascending: true })
        .range(index, index)
        .maybeSingle()

      if (slideError) throw slideError
      mediaUrl = slide?.image_url || ''
      mediaLabel = `slide-${index + 1}`
    }

    if (!mediaUrl) {
      return res.status(404).json({ ok: false, message: 'Media file not found' })
    }

    const parsedUrl = new URL(mediaUrl)
    const allowedHosts = new Set(
      [process.env.R2_PUBLIC_URL, process.env.SUPABASE_URL]
        .filter(Boolean)
        .map((value) => new URL(value).hostname)
    )

    if (
      parsedUrl.protocol !== 'https:' ||
      !allowedHosts.has(parsedUrl.hostname)
    ) {
      return res.status(400).json({ ok: false, message: 'Media source is not allowed' })
    }

    const mediaResponse = await fetch(mediaUrl, {
      signal: controller.signal,
      redirect: 'follow',
    })

    if (!mediaResponse.ok) {
      return res.status(502).json({
        ok: false,
        message: `Media server returned ${mediaResponse.status}`,
      })
    }

    const contentType =
      mediaResponse.headers.get('content-type')?.split(';')[0] ||
      'application/octet-stream'
    const extensionFromUrl =
      parsedUrl.pathname.match(/\.(jpe?g|png|webp|gif|avif)$/i)?.[1]?.toLowerCase()
    const extensionByType = {
      'image/jpeg': 'jpg',
      'image/png': 'png',
      'image/webp': 'webp',
      'image/gif': 'gif',
      'image/avif': 'avif',
    }
    const extension = extensionFromUrl || extensionByType[contentType] || 'bin'
    const asciiName = `story-${story.id}-${mediaLabel}.${extension}`
    const displayTitle =
      cleanText(story.title)
        .replace(/[\\/:*?"<>|]+/g, '')
        .slice(0, 80) || 'story'
    const displayName = `${displayTitle}-${mediaLabel}.${extension}`
    const buffer = Buffer.from(await mediaResponse.arrayBuffer())

    res.setHeader('Content-Type', contentType)
    res.setHeader('Content-Length', String(buffer.length))
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(displayName)}`
    )
    res.setHeader('Cache-Control', 'private, no-store')
    return res.status(200).send(buffer)
  } catch (error) {
    if (error?.name === 'AbortError') {
      return res.status(504).json({ ok: false, message: 'Media download timed out' })
    }

    console.error('DOWNLOAD ADMIN STORY MEDIA ERROR:', error)
    return res.status(500).json({
      ok: false,
      message: 'Failed to download story media',
      error: error.message,
    })
  } finally {
    clearTimeout(timeout)
  }
}

