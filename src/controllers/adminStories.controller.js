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

    const storySlides = slides || []
    const storyData = publicStory(story, authors.get(story.author_id))

    return res.status(200).json({
      ok: true,
      story: {
        ...storyData,
        slides: storySlides,
      },
      slides: storySlides,
      episodes: episodes || [],
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
