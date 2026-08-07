import { supabase } from '../config/supabase.js'
import { FREE_PUBLISHED_EPISODE_LIMIT } from '../services/episodeAccess.service.js'
import { episodeContentToPlainText } from '../utils/episodeContent.js'

const PAID_NOVEL_MINIMUMS = {
  Khmer: 7000,
  English: 5000,
  Chinese: 3000,
  Japanese: 3000,
  Korean: 4000,
}

const PAID_MANGA_MIN_PAGES = 15
const PAID_CHAT_MIN_MESSAGES = 30
const PAID_CHAT_MIN_CHARACTERS = 2500

function cleanText(value) {
  return String(value || '').trim()
}

function cleanBoolean(value, fallback = false) {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value === 1

  const text = cleanText(value).toLowerCase()
  if (['true', '1', 'yes', 'on'].includes(text)) return true
  if (['false', '0', 'no', 'off'].includes(text)) return false

  return fallback
}

function countPaidCharacters(value) {
  return Array.from(String(value || '').replace(/\s/gu, '')).length
}

function paidRequirementResponse(requirement) {
  return {
    ok: false,
    code: 'PAID_CONTENT_REQUIREMENT_NOT_MET',
    message: 'More content is needed for paid access.',
    paid_requirement: requirement,
  }
}

function getNovelRequirement(story, episode) {
  const language = PAID_NOVEL_MINIMUMS[story.story_language]
    ? story.story_language
    : 'English'
  const requiredCharacters = PAID_NOVEL_MINIMUMS[language]
  const currentCharacters = countPaidCharacters(
    episodeContentToPlainText(episode.content)
  )

  return {
    eligible: currentCharacters >= requiredCharacters,
    type: 'novel',
    language,
    required_characters: requiredCharacters,
    current_characters: currentCharacters,
  }
}

function getChatRequirement(episode) {
  let parsed = null

  try {
    parsed = JSON.parse(String(episode.content || ''))
  } catch {
    parsed = null
  }

  const messages = Array.isArray(parsed?.messages)
    ? parsed.messages.filter((message) => {
        const type = cleanText(message?.type).toLowerCase()
        return ['chat', 'aside'].includes(type) && cleanText(message?.text)
      })
    : []
  const currentCharacters = countPaidCharacters(
    messages.map((message) => cleanText(message.text)).join('')
  )

  return {
    eligible:
      messages.length >= PAID_CHAT_MIN_MESSAGES &&
      currentCharacters >= PAID_CHAT_MIN_CHARACTERS,
    type: 'chat_story',
    required_messages: PAID_CHAT_MIN_MESSAGES,
    current_messages: messages.length,
    required_characters: PAID_CHAT_MIN_CHARACTERS,
    current_characters: currentCharacters,
  }
}

async function getMangaRequirement(episodeId) {
  const { count, error } = await supabase
    .from('episode_pages')
    .select('id', { count: 'exact', head: true })
    .eq('episode_id', episodeId)

  if (error) throw error

  const currentPages = Number(count || 0)

  return {
    eligible: currentPages >= PAID_MANGA_MIN_PAGES,
    type: 'manga',
    required_pages: PAID_MANGA_MIN_PAGES,
    current_pages: currentPages,
  }
}

export async function enforcePaidContentRequirement(req, res, next) {
  try {
    const userId = req.user?.user_id
    const { storyId, episodeId } = req.params
    const status = cleanText(req.body.status).toLowerCase()

    if (
      !userId ||
      !['published', 'scheduled'].includes(status)
    ) {
      return next()
    }

    const { data: story, error: storyError } = await supabase
      .from('stories')
      .select('id, user_id, story_type, story_language')
      .eq('id', storyId)
      .eq('user_id', userId)
      .is('deleted_at', null)
      .maybeSingle()

    if (storyError) throw storyError
    if (!story) return next()

    const { data: episode, error: episodeError } = await supabase
      .from('episodes')
      .select(
        'id, story_id, user_id, episode_number, content, is_free_published'
      )
      .eq('id', episodeId)
      .eq('story_id', storyId)
      .eq('user_id', userId)
      .is('deleted_at', null)
      .maybeSingle()

    if (episodeError) throw episodeError
    if (!episode) return next()

    const requestedFree =
      req.body.is_free_published ??
      req.body.isFreePublished
    const isFreePublished =
      requestedFree === undefined
        ? Boolean(episode.is_free_published)
        : cleanBoolean(requestedFree)
    const isAutomaticallyFree =
      Number(episode.episode_number || 0) <=
      FREE_PUBLISHED_EPISODE_LIMIT

    if (isFreePublished || isAutomaticallyFree) {
      return next()
    }

    let requirement

    if (story.story_type === 'manga') {
      requirement = await getMangaRequirement(episode.id)
    } else if (story.story_type === 'chat_story') {
      requirement = getChatRequirement(episode)
    } else {
      requirement = getNovelRequirement(story, episode)
    }

    if (requirement.eligible) return next()

    const { eligible, ...publicRequirement } = requirement

    return res
      .status(409)
      .json(paidRequirementResponse(publicRequirement))
  } catch (error) {
    console.error('PAID CONTENT REQUIREMENT ERROR:', error)

    return res.status(500).json({
      ok: false,
      code: 'PAID_CONTENT_REQUIREMENT_CHECK_FAILED',
      message: 'Failed to check paid episode requirements',
      error: error.message,
    })
  }
}
