import { supabase } from '../config/supabase.js'
import { blockedWordsWarningPayload, findBlockedWordsInContent } from '../utils/blockedWords.js'

const ALLOWED_LANGUAGES = ['Khmer', 'English', 'Chinese', 'Japanese', 'Korean']
const ALLOWED_UPDATE_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const ALLOWED_STORY_STATUSES = ['New', 'Ongoing', 'Completed']
const ALLOWED_UNLOCK_METHODS = ['gem', 'voucher', 'story_card', 'free_item']
const MIN_EPISODE_CHARACTERS = 1500
const MAX_EPISODE_CHARACTERS = 30000
const AUTHOR_TRASH_DAYS = 30
const ADMIN_ARCHIVE_DAYS = 90

function cleanText(value) {
  return String(value || '').trim()
}

function addDays(date, days) {
  const nextDate = new Date(date)
  nextDate.setDate(nextDate.getDate() + days)
  return nextDate
}

function isRestoreExpired(value) {
  if (!value) return true

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return true

  return date.getTime() <= Date.now()
}
function calculateWordCount(value) {
  const text = String(value || '').trim()

  if (!text) return 0

  const latinWords = text
    .replace(/[\u1780-\u17FF]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean).length

  const khmerChars = (text.match(/[\u1780-\u17FF]/g) || []).length
  const khmerEstimatedWords = Math.ceil(khmerChars / 6)

  return latinWords + khmerEstimatedWords
}

function cleanNullableText(value) {
  const text = cleanText(value)
  return text || null
}

function cleanTags(value) {
  if (!Array.isArray(value)) return []

  return value
    .map((tag) => cleanText(tag))
    .filter(Boolean)
    .slice(0, 6)
}

function cleanUpdateDays(value) {
  if (!Array.isArray(value)) return []

  return value
    .map((day) => cleanText(day))
    .filter((day) => ALLOWED_UPDATE_DAYS.includes(day))
    .filter((day, index, array) => array.indexOf(day) === index)
}

function cleanStoryStatus(value) {
  const status = cleanText(value || 'New')
  return ALLOWED_STORY_STATUSES.includes(status) ? status : 'New'
}

function cleanUnlockMethods(value) {
  if (!Array.isArray(value)) return []

  return value
    .map((method) => cleanText(method))
    .filter((method) => ALLOWED_UNLOCK_METHODS.includes(method))
    .filter((method, index, array) => array.indexOf(method) === index)
}

function publicStory(story, slides = []) {
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
    is_adult: story.is_adult,
    cover_url: story.cover_url,
    status: story.status,
    update_days: story.update_days || [],
    total_episodes: story.total_episodes,
    total_views: story.total_views,
    total_likes: story.total_likes,
    total_comments: story.total_comments,
    slides,
    deleted_at: story.deleted_at || null,
    delete_expires_at: story.delete_expires_at || null,
    admin_archive_expires_at: story.admin_archive_expires_at || null,
    deleted_by_user_id: story.deleted_by_user_id || null,
    days_left: story.delete_expires_at
      ? Math.max(0, Math.ceil((new Date(story.delete_expires_at).getTime() - Date.now()) / 86400000))
      : null,
    created_at: story.created_at,
    updated_at: story.updated_at,
  }
}

function publicEpisode(episode) {
  if (!episode) return null

  return {
    id: episode.id,
    story_id: episode.story_id,
    author_id: episode.author_id,
    user_id: episode.user_id,
    title: episode.title,
    cover_url: episode.cover_url,
    content: episode.content,
    is_adult: episode.is_adult,
    is_locked: Boolean(episode.is_locked),
    unlock_methods: episode.unlock_methods || [],
    status: episode.status,
    episode_number: episode.episode_number,
    character_count: episode.character_count,
    word_count: episode.word_count,
    total_likes: episode.total_likes || 0,
    published_at: episode.published_at,
    scheduled_at: episode.scheduled_at,
    deleted_at: episode.deleted_at || null,
    delete_expires_at: episode.delete_expires_at || null,
    created_at: episode.created_at,
    updated_at: episode.updated_at,
  }
}

async function getAuthorPageForUser(userId) {
  const { data, error } = await supabase
    .from('author_pages')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle()

  if (error) throw error
  return data
}

async function getOwnedStory({ storyId, userId, includeDeleted = false }) {
  let query = supabase
    .from('stories')
    .select('*')
    .eq('id', storyId)
    .eq('user_id', userId)

  if (!includeDeleted) {
    query = query.is('deleted_at', null)
  }

  const { data, error } = await query.maybeSingle()

  if (error) throw error
  return data
}

async function getOwnedEpisode({ storyId, episodeId, userId, includeDeleted = false }) {
  let query = supabase
    .from('episodes')
    .select('*')
    .eq('id', episodeId)
    .eq('story_id', storyId)
    .eq('user_id', userId)

  if (!includeDeleted) {
    query = query.is('deleted_at', null)
  }

  const { data, error } = await query.maybeSingle()

  if (error) throw error
  return data
}

async function getNextEpisodeNumber(storyId) {
  const { data, error } = await supabase
    .from('episodes')
    .select('episode_number')
    .eq('story_id', storyId)
    .order('episode_number', { ascending: false })
    .limit(1)

  if (error) throw error

  const latestNumber = data?.[0]?.episode_number || 0
  return latestNumber + 1
}

async function updateStoryEpisodeCount(storyId) {
  const { count, error: countError } = await supabase
    .from('episodes')
    .select('id', { count: 'exact', head: true })
    .eq('story_id', storyId)
    .is('deleted_at', null)

  if (countError) throw countError

  const { error: updateError } = await supabase
    .from('stories')
    .update({
      total_episodes: count || 0,
      updated_at: new Date().toISOString(),
    })
    .eq('id', storyId)

  if (updateError) throw updateError

  return count || 0
}

async function updateStoryStatusAfterEpisodeChange(storyId) {
  const { data: publishedEpisodes, error: publishedError } = await supabase
    .from('episodes')
    .select('id')
    .eq('story_id', storyId)
    .eq('status', 'published')
    .is('deleted_at', null)
    .limit(1)

  if (publishedError) throw publishedError

  const hasPublishedEpisode = Boolean(publishedEpisodes?.length)

  if (hasPublishedEpisode) {
    const { error } = await supabase
      .from('stories')
      .update({
        status: 'published',
        updated_at: new Date().toISOString(),
      })
      .eq('id', storyId)

    if (error) throw error
  }
}

async function getStorySlides(storyId) {
  const { data, error } = await supabase
    .from('story_carousel_slides')
    .select('*')
    .eq('story_id', storyId)
    .order('sort_order', { ascending: true })

  if (error) throw error
  return data || []
}

async function replaceStorySlides(storyId, slides) {
  const { error: deleteError } = await supabase
    .from('story_carousel_slides')
    .delete()
    .eq('story_id', storyId)

  if (deleteError) throw deleteError

  const slideRows = (Array.isArray(slides) ? slides : [])
    .slice(0, 5)
    .map((slide, index) => ({
      story_id: storyId,
      image_url: cleanText(slide.image_url || slide.imageUrl),
      link_url: cleanNullableText(slide.link_url || slide.linkUrl),
      sort_order: Number.isFinite(Number(slide.sort_order ?? slide.sortOrder))
        ? Number(slide.sort_order ?? slide.sortOrder)
        : index,
      is_active: slide.is_active ?? slide.isActive ?? true,
    }))
    .filter((slide) => slide.image_url)

  if (!slideRows.length) return []

  const { data, error } = await supabase
    .from('story_carousel_slides')
    .insert(slideRows)
    .select()

  if (error) throw error

  return data || []
}

function validateStoryPayload({ title, storyLanguage, mainGenre, description }) {
  if (!title) {
    return 'Story title is required'
  }

  if (title.length < 2) {
    return 'Story title must be at least 2 characters'
  }

  if (!ALLOWED_LANGUAGES.includes(storyLanguage)) {
    return 'Invalid story language'
  }

  if (!mainGenre) {
    return 'Main genre is required'
  }

  if (description && description.length > 5000) {
    return 'Description must be 5000 characters or less'
  }

  return ''
}

export async function createStory(req, res) {
  try {
    const userId = req.user?.user_id

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    const authorPage = await getAuthorPageForUser(userId)

    if (!authorPage) {
      return res.status(403).json({
        ok: false,
        message: 'Please create an author page first',
      })
    }

    const title = cleanText(req.body.title)
    const storyLanguage = cleanText(req.body.story_language || req.body.storyLanguage || 'Khmer')
    const mainGenre = cleanText(req.body.main_genre || req.body.mainGenre)
    const storyStatus = cleanStoryStatus(req.body.story_status || req.body.storyStatus || 'New')
    const tags = cleanTags(req.body.tags)
    const description = cleanNullableText(req.body.description)
    const isAdult = Boolean(req.body.is_adult ?? req.body.isAdult)
    const coverUrl = cleanNullableText(req.body.cover_url || req.body.coverUrl)
    const updateDays = cleanUpdateDays(req.body.update_days || req.body.updateDays)
    const slides = Array.isArray(req.body.slides) ? req.body.slides.slice(0, 5) : []

    const payloadError = validateStoryPayload({ title, storyLanguage, mainGenre, description })

    if (payloadError) {
      return res.status(400).json({
        ok: false,
        message: payloadError,
      })
    }

    const { data: story, error: storyError } = await supabase
      .from('stories')
      .insert({
        author_id: authorPage.id,
        user_id: userId,
        title,
        story_language: storyLanguage,
        main_genre: mainGenre,
        story_status: storyStatus,
        tags,
        description,
        is_adult: isAdult,
        cover_url: coverUrl,
        update_days: updateDays,
        status: 'draft',
      })
      .select()
      .single()

    if (storyError) throw storyError

    const createdSlides = await replaceStorySlides(story.id, slides)

    return res.status(201).json({
      ok: true,
      message: 'Story created successfully',
      story: publicStory(story, createdSlides),
    })
  } catch (error) {
    console.error('CREATE STORY ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to create story',
      error: error.message,
    })
  }
}

export async function updateStory(req, res) {
  try {
    const userId = req.user?.user_id
    const { storyId } = req.params

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    const oldStory = await getOwnedStory({ storyId, userId })

    if (!oldStory) {
      return res.status(404).json({
        ok: false,
        message: 'Story not found',
      })
    }

    const title = cleanText(req.body.title)
    const storyLanguage = cleanText(req.body.story_language || req.body.storyLanguage || oldStory.story_language || 'Khmer')
    const storyStatus = cleanStoryStatus(req.body.story_status || req.body.storyStatus || oldStory.story_status || 'New')
    const mainGenre = cleanText(req.body.main_genre || req.body.mainGenre)
    const tags = cleanTags(req.body.tags)
    const description = cleanNullableText(req.body.description)
    const isAdult = Boolean(req.body.is_adult ?? req.body.isAdult)
    const coverUrl = cleanNullableText(req.body.cover_url || req.body.coverUrl)
    const updateDays = cleanUpdateDays(req.body.update_days || req.body.updateDays)
    const slides = Array.isArray(req.body.slides) ? req.body.slides.slice(0, 5) : []

    const payloadError = validateStoryPayload({ title, storyLanguage, mainGenre, description })

    if (payloadError) {
      return res.status(400).json({
        ok: false,
        message: payloadError,
      })
    }

    const { data: story, error: storyError } = await supabase
      .from('stories')
      .update({
        title,
        story_language: storyLanguage,
        main_genre: mainGenre,
        story_status: storyStatus,
        tags,
        description,
        is_adult: isAdult,
        cover_url: coverUrl,
        update_days: updateDays,
        updated_at: new Date().toISOString(),
      })
      .eq('id', storyId)
      .eq('user_id', userId)
      .select()
      .single()

    if (storyError) throw storyError

    const updatedSlides = await replaceStorySlides(storyId, slides)

    return res.status(200).json({
      ok: true,
      message: 'Story updated successfully',
      story: publicStory(story, updatedSlides),
    })
  } catch (error) {
    console.error('UPDATE STORY ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to update story',
      error: error.message,
    })
  }
}

export async function getMyStories(req, res) {
  try {
    const userId = req.user?.user_id

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    const authorPage = await getAuthorPageForUser(userId)

    if (!authorPage) {
      return res.status(200).json({
        ok: true,
        stories: [],
      })
    }

    const { data, error } = await supabase
      .from('stories')
      .select('*')
      .eq('author_id', authorPage.id)
      .is('deleted_at', null)
      .order('created_at', { ascending: false })

    if (error) throw error

    return res.status(200).json({
      ok: true,
      stories: data || [],
    })
  } catch (error) {
    console.error('GET MY STORIES ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to fetch stories',
      error: error.message,
    })
  }
}

export async function getStoryById(req, res) {
  try {
    const userId = req.user?.user_id
    const { storyId } = req.params

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    const story = await getOwnedStory({ storyId, userId })

    if (!story) {
      return res.status(404).json({
        ok: false,
        message: 'Story not found',
      })
    }

    const slides = await getStorySlides(storyId)

    return res.status(200).json({
      ok: true,
      story: publicStory(story, slides || []),
    })
  } catch (error) {
    console.error('GET STORY BY ID ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to fetch story',
      error: error.message,
    })
  }
}

export async function createEpisode(req, res) {
  try {
    const userId = req.user?.user_id
    const { storyId } = req.params

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    const story = await getOwnedStory({ storyId, userId })

    if (!story) {
      return res.status(404).json({
        ok: false,
        message: 'Story not found',
      })
    }

    const title = cleanText(req.body.title)
    const content = String(req.body.content || '')
    const coverUrl = cleanNullableText(req.body.cover_url || req.body.coverUrl)
    const isAdult = Boolean(req.body.is_adult ?? req.body.isAdult)
    const status = cleanText(req.body.status || 'draft')
    const characterCount = content.length
    const wordCount = calculateWordCount(content)

    if (!title) {
      return res.status(400).json({
        ok: false,
        message: 'Episode title is required',
      })
    }

    if (status !== 'draft' && title.length < 2) {
  return res.status(400).json({
    ok: false,
    message: 'Episode title must be at least 2 characters',
  })
}
    if (!content.trim()) {
      return res.status(400).json({
        ok: false,
        message: 'Episode content is required',
      })
    }

    if (status !== 'draft' && characterCount < MIN_EPISODE_CHARACTERS) {
  return res.status(400).json({
    ok: false,
    message: `Episode needs at least ${MIN_EPISODE_CHARACTERS} characters`,
  })
}

    if (characterCount > MAX_EPISODE_CHARACTERS) {
      return res.status(400).json({
        ok: false,
        message: `Episode must be ${MAX_EPISODE_CHARACTERS} characters or less`,
      })
    }

    if (!['draft', 'ready'].includes(status)) {
      return res.status(400).json({
        ok: false,
        message: 'Invalid episode status',
      })
    }

    const episodeNumber = await getNextEpisodeNumber(storyId)
    const defaultLocked = episodeNumber > 1

    const isLocked =
      typeof req.body.is_locked === 'boolean'
        ? req.body.is_locked
        : typeof req.body.isLocked === 'boolean'
          ? req.body.isLocked
          : defaultLocked

    const unlockMethods = cleanUnlockMethods(req.body.unlock_methods || req.body.unlockMethods)

    const { data: episode, error: episodeError } = await supabase
      .from('episodes')
      .insert({
        story_id: story.id,
        author_id: story.author_id,
        user_id: userId,
        title,
        cover_url: coverUrl,
        content,
        is_adult: isAdult,
        is_locked: isLocked,
        unlock_methods: unlockMethods,
        status,
        episode_number: episodeNumber,
        character_count: characterCount,
word_count: wordCount,
      })
      .select()
      .single()

    if (episodeError) throw episodeError

    const totalEpisodes = await updateStoryEpisodeCount(storyId)

    return res.status(201).json({
      ok: true,
      message: 'Episode created successfully',
      episode: publicEpisode(episode),
      total_episodes: totalEpisodes,
    })
  } catch (error) {
    console.error('CREATE EPISODE ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to create episode',
      error: error.message,
    })
  }
}

export async function getStoryEpisodes(req, res) {
  try {
    const userId = req.user?.user_id
    const { storyId } = req.params

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    const story = await getOwnedStory({ storyId, userId })

    if (!story) {
      return res.status(404).json({
        ok: false,
        message: 'Story not found',
      })
    }

    const { data, error } = await supabase
      .from('episodes')
      .select('*')
      .eq('story_id', storyId)
      .is('deleted_at', null)
      .order('episode_number', { ascending: true })

    if (error) throw error

    return res.status(200).json({
      ok: true,
      episodes: (data || []).map(publicEpisode),
    })
  } catch (error) {
    console.error('GET STORY EPISODES ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to fetch episodes',
      error: error.message,
    })
  }
}

export async function getEpisodeById(req, res) {
  try {
    const userId = req.user?.user_id
    const { storyId, episodeId } = req.params

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    const story = await getOwnedStory({ storyId, userId })

    if (!story) {
      return res.status(404).json({
        ok: false,
        message: 'Story not found',
      })
    }

    const episode = await getOwnedEpisode({ storyId, episodeId, userId })

    if (!episode) {
      return res.status(404).json({
        ok: false,
        message: 'Episode not found',
      })
    }

    return res.status(200).json({
      ok: true,
      episode: publicEpisode(episode),
    })
  } catch (error) {
    console.error('GET EPISODE BY ID ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to fetch episode',
      error: error.message,
    })
  }
}

export async function updateEpisode(req, res) {
  try {
    const userId = req.user?.user_id
    const { storyId, episodeId } = req.params

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    const story = await getOwnedStory({ storyId, userId })

    if (!story) {
      return res.status(404).json({
        ok: false,
        message: 'Story not found',
      })
    }

    const episode = await getOwnedEpisode({ storyId, episodeId, userId })

    if (!episode) {
      return res.status(404).json({
        ok: false,
        message: 'Episode not found',
      })
    }

    const title = cleanText(req.body.title)
    const content = String(req.body.content || '')
    const coverUrl = cleanNullableText(req.body.cover_url || req.body.coverUrl)
    const isAdult = Boolean(req.body.is_adult ?? req.body.isAdult)
    const status = cleanText(req.body.status || episode.status || 'draft')
    const isLocked =
      typeof req.body.is_locked === 'boolean'
        ? req.body.is_locked
        : typeof req.body.isLocked === 'boolean'
          ? req.body.isLocked
          : Boolean(episode.is_locked)
    const unlockMethods = cleanUnlockMethods(req.body.unlock_methods || req.body.unlockMethods || episode.unlock_methods)
    const characterCount = content.length
    const wordCount = calculateWordCount(content)

    if (!title) {
      return res.status(400).json({
        ok: false,
        message: 'Episode title is required',
      })
    }

    if (status !== 'draft' && title.length < 2) {
  return res.status(400).json({
    ok: false,
    message: 'Episode title must be at least 2 characters',
  })
}

    if (!content.trim()) {
      return res.status(400).json({
        ok: false,
        message: 'Episode content is required',
      })
    }

    if (status !== 'draft' && characterCount < MIN_EPISODE_CHARACTERS) {
  return res.status(400).json({
    ok: false,
    message: `Episode needs at least ${MIN_EPISODE_CHARACTERS} characters`,
  })
}

    if (characterCount > MAX_EPISODE_CHARACTERS) {
      return res.status(400).json({
        ok: false,
        message: `Episode must be ${MAX_EPISODE_CHARACTERS} characters or less`,
      })
    }

    if (!['draft', 'ready', 'published', 'scheduled'].includes(status)) {
      return res.status(400).json({
        ok: false,
        message: 'Invalid episode status',
      })
    }

    const updatePayload = {
      title,
      cover_url: coverUrl,
      content,
      is_adult: isAdult,
      is_locked: isLocked,
      unlock_methods: unlockMethods,
      status,
      character_count: characterCount,
word_count: wordCount,
      updated_at: new Date().toISOString(),
    }

    const { data: updatedEpisode, error: updateError } = await supabase
      .from('episodes')
      .update(updatePayload)
      .eq('id', episodeId)
      .eq('story_id', storyId)
      .eq('user_id', userId)
      .select()
      .single()

    if (updateError) throw updateError

    await supabase
      .from('stories')
      .update({
        updated_at: new Date().toISOString(),
      })
      .eq('id', storyId)

    return res.status(200).json({
      ok: true,
      message: 'Episode updated successfully',
      episode: publicEpisode(updatedEpisode),
    })
  } catch (error) {
    console.error('UPDATE EPISODE ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to update episode',
      error: error.message,
    })
  }
}

export async function updateEpisodeStatus(req, res) {
  try {
    const userId = req.user?.user_id
    const { storyId, episodeId } = req.params

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    const story = await getOwnedStory({ storyId, userId })

    if (!story) {
      return res.status(404).json({
        ok: false,
        message: 'Story not found',
      })
    }

    const episode = await getOwnedEpisode({ storyId, episodeId, userId })

    if (!episode) {
      return res.status(404).json({
        ok: false,
        message: 'Episode not found',
      })
    }

    const status = cleanText(req.body.status)

    if (!['published', 'scheduled', 'draft'].includes(status)) {
      return res.status(400).json({
        ok: false,
        message: 'Invalid publish status',
      })
    }

    if (['published', 'scheduled'].includes(status)) {
  if (Number(episode.character_count || 0) < MIN_EPISODE_CHARACTERS) {
    return res.status(400).json({
      ok: false,
      message: `Episode needs at least ${MIN_EPISODE_CHARACTERS} characters before publishing`,
    })
  }

  const blockedMatches = await findBlockedWordsInContent([
    { label: 'Story Title', value: story.title },
    { label: 'Story Description', value: story.description },
    { label: 'Episode Title', value: episode.title },
    { label: 'Episode Content', value: episode.content },
  ])

  if (blockedMatches.length) {
    return res.status(422).json(blockedWordsWarningPayload(blockedMatches))
  }
}

    const updatePayload = {
      status,
      updated_at: new Date().toISOString(),
    }

    if (status === 'published') {
      updatePayload.published_at = new Date().toISOString()
      updatePayload.scheduled_at = null
    }

    if (status === 'scheduled') {
      const scheduledAt = cleanText(req.body.scheduled_at || req.body.scheduledAt)

      if (!scheduledAt) {
        return res.status(400).json({
          ok: false,
          message: 'Schedule date and time are required',
        })
      }

      const scheduleDate = new Date(scheduledAt)

      if (Number.isNaN(scheduleDate.getTime())) {
        return res.status(400).json({
          ok: false,
          message: 'Invalid schedule date and time',
        })
      }

      updatePayload.scheduled_at = scheduleDate.toISOString()
      updatePayload.published_at = null
    }

    if (status === 'draft') {
      updatePayload.scheduled_at = null
      updatePayload.published_at = null
    }

    const { data: updatedEpisode, error: updateError } = await supabase
      .from('episodes')
      .update(updatePayload)
      .eq('id', episodeId)
      .eq('story_id', storyId)
      .eq('user_id', userId)
      .select()
      .single()

    if (updateError) throw updateError

    if (status === 'published') {
      await updateStoryStatusAfterEpisodeChange(storyId)
    }

    return res.status(200).json({
      ok: true,
      message:
        status === 'published'
          ? 'Episode published successfully'
          : status === 'scheduled'
            ? 'Episode scheduled successfully'
            : 'Episode saved as draft',
      episode: publicEpisode(updatedEpisode),
    })
  } catch (error) {
    console.error('UPDATE EPISODE STATUS ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to update episode status',
      error: error.message,
    })
  }
}

export async function getStoryTrash(req, res) {
  try {
    const userId = req.user?.user_id

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    const authorPage = await getAuthorPageForUser(userId)

    if (!authorPage) {
      return res.status(200).json({
        ok: true,
        stories: [],
      })
    }

    const { data, error } = await supabase
      .from('stories')
      .select('*')
      .eq('author_id', authorPage.id)
      .not('deleted_at', 'is', null)
      .order('deleted_at', { ascending: false })

    if (error) throw error

    return res.status(200).json({
      ok: true,
      stories: (data || []).map((story) => publicStory(story)),
    })
  } catch (error) {
    console.error('GET STORY TRASH ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to fetch story trash',
      error: error.message,
    })
  }
}

export async function moveStoryToTrash(req, res) {
  try {
    const userId = req.user?.user_id
    const { storyId } = req.params

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    const story = await getOwnedStory({ storyId, userId })

    if (!story) {
      return res.status(404).json({
        ok: false,
        message: 'Story not found',
      })
    }

    const now = new Date()
    const deletedAt = now.toISOString()
    const deleteExpiresAt = addDays(now, AUTHOR_TRASH_DAYS).toISOString()
    const adminArchiveExpiresAt = addDays(now, AUTHOR_TRASH_DAYS + ADMIN_ARCHIVE_DAYS).toISOString()

    const { data: updatedStory, error: storyError } = await supabase
      .from('stories')
      .update({
        deleted_at: deletedAt,
        delete_expires_at: deleteExpiresAt,
        admin_archive_expires_at: adminArchiveExpiresAt,
        deleted_by_user_id: userId,
        updated_at: deletedAt,
      })
      .eq('id', storyId)
      .eq('user_id', userId)
      .is('deleted_at', null)
      .select()
      .single()

    if (storyError) throw storyError

    const { error: episodeError } = await supabase
      .from('episodes')
      .update({
        deleted_at: deletedAt,
        delete_expires_at: deleteExpiresAt,
        updated_at: deletedAt,
      })
      .eq('story_id', storyId)
      .eq('user_id', userId)
      .is('deleted_at', null)

    if (episodeError) throw episodeError

    return res.status(200).json({
      ok: true,
      message: 'Story moved to Trash. You can restore it within 30 days.',
      story: publicStory(updatedStory),
    })
  } catch (error) {
    console.error('MOVE STORY TO TRASH ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to move story to Trash',
      error: error.message,
    })
  }
}

export async function restoreStoryFromTrash(req, res) {
  try {
    const userId = req.user?.user_id
    const { storyId } = req.params

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    const story = await getOwnedStory({ storyId, userId, includeDeleted: true })

    if (!story || !story.deleted_at) {
      return res.status(404).json({
        ok: false,
        message: 'Story not found in Trash',
      })
    }

    if (isRestoreExpired(story.delete_expires_at)) {
      return res.status(403).json({
        ok: false,
        message: 'Restore period expired. This story is now in admin archive.',
      })
    }

    const restoredAt = new Date().toISOString()

    const { data: restoredStory, error: storyError } = await supabase
      .from('stories')
      .update({
        deleted_at: null,
        delete_expires_at: null,
        admin_archive_expires_at: null,
        deleted_by_user_id: null,
        updated_at: restoredAt,
      })
      .eq('id', storyId)
      .eq('user_id', userId)
      .not('deleted_at', 'is', null)
      .select()
      .single()

    if (storyError) throw storyError

    const { error: episodeError } = await supabase
      .from('episodes')
      .update({
        deleted_at: null,
        delete_expires_at: null,
        updated_at: restoredAt,
      })
      .eq('story_id', storyId)
      .eq('user_id', userId)

    if (episodeError) throw episodeError

    await updateStoryEpisodeCount(storyId)

    return res.status(200).json({
      ok: true,
      message: 'Story restored successfully',
      story: publicStory(restoredStory),
    })
  } catch (error) {
    console.error('RESTORE STORY FROM TRASH ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to restore story',
      error: error.message,
    })
  }
}

