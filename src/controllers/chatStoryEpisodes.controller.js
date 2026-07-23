import { supabase } from '../config/supabase.js'
import { blockedWordsWarningPayload, findBlockedWordsInContent } from '../utils/blockedWords.js'
import { updateEpisodeStatus } from './stories.controller.js'

const MAX_MESSAGES = 1000
const MAX_MESSAGE_CHARACTERS = 2000
const MAX_TOTAL_CHARACTERS = 30000

function cleanText(value) {
  return String(value || '').trim()
}

function cleanNullableText(value) {
  const text = cleanText(value)
  return text || null
}

function calculateWordCount(value) {
  const text = String(value || '').trim()
  if (!text) return 0

  const latinWords = text
    .replace(/[\u1780-\u17FF]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean).length
  const khmerCharacters = (text.match(/[\u1780-\u17FF]/g) || []).length

  return latinWords + Math.ceil(khmerCharacters / 6)
}


async function getOwnedStoryType(storyId, userId) {
  const { data, error } = await supabase
    .from('stories')
    .select('story_type')
    .eq('id', storyId)
    .eq('user_id', userId)
    .is('deleted_at', null)
    .maybeSingle()

  if (error) throw error
  return data?.story_type || ''
}

async function getOwnedChatStory(storyId, userId) {
  const { data, error } = await supabase
    .from('stories')
    .select('*')
    .eq('id', storyId)
    .eq('user_id', userId)
    .eq('story_type', 'chat_story')
    .is('deleted_at', null)
    .maybeSingle()

  if (error) throw error
  return data
}

async function getOwnedEpisode(storyId, episodeId, userId) {
  if (!episodeId) return null

  const { data, error } = await supabase
    .from('episodes')
    .select('*')
    .eq('id', episodeId)
    .eq('story_id', storyId)
    .eq('user_id', userId)
    .is('deleted_at', null)
    .maybeSingle()

  if (error) throw error
  return data
}

async function getNextEpisodeNumber(storyId) {
  const { data, error } = await supabase
    .from('episodes')
    .select('episode_number')
    .eq('story_id', storyId)
    .is('deleted_at', null)
    .order('episode_number', { ascending: false })
    .limit(1)

  if (error) throw error
  return Number(data?.[0]?.episode_number || 0) + 1
}

async function getCharacters(storyId, userId) {
  const { data, error } = await supabase
    .from('chat_story_characters')
    .select('id, nickname, avatar_url, role_group, chat_side, sort_order')
    .eq('story_id', storyId)
    .eq('user_id', userId)
    .order('sort_order', { ascending: true })

  if (error) throw error
  return data || []
}

function normalizeMessages(input, characterIds) {
  if (!Array.isArray(input)) return { error: 'Messages must be an array', messages: [] }
  if (input.length > MAX_MESSAGES) {
    return { error: `Maximum ${MAX_MESSAGES} messages allowed in one episode`, messages: [] }
  }

  const messages = []

  for (let index = 0; index < input.length; index += 1) {
    const item = input[index] || {}
    const type = cleanText(item.type).toLowerCase() === 'chat' ? 'chat' : 'aside'
    const text = cleanText(item.text)
    const characterId = cleanNullableText(item.character_id || item.characterId)

    if (!text) continue
    if (text.length > MAX_MESSAGE_CHARACTERS) {
      return {
        error: `Each message must be ${MAX_MESSAGE_CHARACTERS} characters or less`,
        messages: [],
      }
    }
    if (type === 'chat' && (!characterId || !characterIds.has(characterId))) {
      return { error: 'One or more selected characters are invalid', messages: [] }
    }

    messages.push({
      id: cleanText(item.id) || `${Date.now()}-${index}`,
      type,
      character_id: type === 'chat' ? characterId : null,
      text,
      sort_order: messages.length,
      created_at: cleanNullableText(item.created_at || item.createdAt),
    })
  }

  if (!messages.length) {
    return { error: 'Add at least one Chat or ASIDE message', messages: [] }
  }

  const totalCharacters = messages.reduce((sum, message) => sum + message.text.length, 0)

  if (totalCharacters > MAX_TOTAL_CHARACTERS) {
    return {
      error: `Chat episode must be ${MAX_TOTAL_CHARACTERS} text characters or less`,
      messages: [],
    }
  }

  return { error: '', messages, totalCharacters }
}

function parseChatContent(value) {
  try {
    const parsed = JSON.parse(String(value || ''))
    if (parsed?.format !== 'shadow_chat_story_v1' || !Array.isArray(parsed.messages)) {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

export async function saveChatStoryEpisode(req, res) {
  try {
    const userId = req.user?.user_id
    const { storyId } = req.params

    if (!userId) {
      return res.status(401).json({ ok: false, message: 'Unauthorized' })
    }

    const story = await getOwnedChatStory(storyId, userId)

    if (!story) {
      return res.status(404).json({ ok: false, message: 'Chat Story not found' })
    }

    const title = cleanText(req.body.title)

    if (!title) {
      return res.status(400).json({ ok: false, message: 'Episode title is required' })
    }

    const characters = await getCharacters(storyId, userId)
    const characterIds = new Set(characters.map((character) => String(character.id)))
    const normalized = normalizeMessages(req.body.messages, characterIds)

    if (normalized.error) {
      return res.status(400).json({ ok: false, message: normalized.error })
    }

    const plainText = normalized.messages.map((message) => message.text).join('\n')
    const content = JSON.stringify({
      format: 'shadow_chat_story_v1',
      version: 1,
      story_id: storyId,
      episode_title: title,
      characters: characters.map((character) => ({
        id: character.id,
        nickname: character.nickname || '',
        avatar_url: character.avatar_url || '',
        role_group: character.role_group,
        chat_side: character.chat_side,
        sort_order: character.sort_order,
      })),
      messages: normalized.messages,
    })

    const requestedEpisodeId = cleanNullableText(req.body.episode_id || req.body.episodeId)
    const existingEpisode = await getOwnedEpisode(storyId, requestedEpisodeId, userId)
    const now = new Date().toISOString()
    const episodeNumber = existingEpisode?.episode_number || await getNextEpisodeNumber(storyId)
    const payload = {
      title,
      content,
      status: 'ready',
      is_locked:
        typeof req.body.is_locked === 'boolean'
          ? req.body.is_locked
          : typeof req.body.isLocked === 'boolean'
            ? req.body.isLocked
            : true,
      character_count: normalized.totalCharacters,
      word_count: calculateWordCount(plainText),
      page_count: 0,
      updated_at: now,
    }

    let episode

    if (existingEpisode) {
      const { data, error } = await supabase
        .from('episodes')
        .update(payload)
        .eq('id', existingEpisode.id)
        .eq('story_id', storyId)
        .eq('user_id', userId)
        .select()
        .single()

      if (error) throw error
      episode = data
    } else {
      const { data, error } = await supabase
        .from('episodes')
        .insert({
          story_id: story.id,
          author_id: story.author_id,
          user_id: userId,
          episode_number: episodeNumber,
          cover_url: null,
          is_adult: false,
          unlock_methods: [],
          ...payload,
        })
        .select()
        .single()

      if (error) throw error
      episode = data

      const { count, error: countError } = await supabase
        .from('episodes')
        .select('id', { count: 'exact', head: true })
        .eq('story_id', storyId)
        .is('deleted_at', null)

      if (countError) throw countError

      const { error: storyUpdateError } = await supabase
        .from('stories')
        .update({ total_episodes: count || 0, updated_at: now })
        .eq('id', storyId)

      if (storyUpdateError) throw storyUpdateError
    }

    return res.status(existingEpisode ? 200 : 201).json({
      ok: true,
      message: existingEpisode
        ? 'Chat Story episode updated successfully'
        : 'Chat Story episode created successfully',
      episode,
      is_first_episode: Number(episode.episode_number || 0) === 1,
    })
  } catch (error) {
    console.error('SAVE CHAT STORY EPISODE ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to save Chat Story episode',
      error: error.message,
    })
  }
}

export async function updateChatStoryEpisodeStatus(req, res) {
  try {
    const userId = req.user?.user_id
    const { storyId, episodeId } = req.params

    if (!userId) {
      return res.status(401).json({ ok: false, message: 'Unauthorized' })
    }

    const story = await getOwnedChatStory(storyId, userId)
    const episode = await getOwnedEpisode(storyId, episodeId, userId)

    if (!story || !episode) {
      return res.status(404).json({ ok: false, message: 'Chat Story episode not found' })
    }

    const chatContent = parseChatContent(episode.content)

    if (!chatContent?.messages?.length) {
      return res.status(400).json({ ok: false, message: 'Chat Story episode has no messages' })
    }

    const status = cleanText(req.body.status)

    if (!['published', 'scheduled', 'draft'].includes(status)) {
      return res.status(400).json({ ok: false, message: 'Invalid publish status' })
    }

    const plainText = chatContent.messages
      .map((message) => cleanText(message.text))
      .filter(Boolean)
      .join('\n')

    if (['published', 'scheduled'].includes(status)) {
      const blockedMatches = await findBlockedWordsInContent([
        { label: 'Story Title', value: story.title },
        { label: 'Story Description', value: story.description },
        { label: 'Episode Title', value: episode.title },
        { label: 'Episode Content', value: plainText },
      ])

      if (blockedMatches.length) {
        return res.status(422).json(blockedWordsWarningPayload(blockedMatches))
      }
    }

    const now = new Date().toISOString()
    const updatePayload = {
      status,
      is_adult: Boolean(req.body.is_adult ?? req.body.isAdult),
      updated_at: now,
    }

    if (status === 'published') {
      updatePayload.published_at = now
      updatePayload.scheduled_at = null
    }

    if (status === 'scheduled') {
      const scheduledAt = cleanText(req.body.scheduled_at || req.body.scheduledAt)
      const scheduledDate = new Date(scheduledAt)

      if (!scheduledAt || Number.isNaN(scheduledDate.getTime())) {
        return res.status(400).json({
          ok: false,
          message: 'Valid schedule date and time are required',
        })
      }

      updatePayload.scheduled_at = scheduledDate.toISOString()
      updatePayload.published_at = null
    }

    if (status === 'draft') {
      updatePayload.scheduled_at = null
      updatePayload.published_at = null
    }

    const { data: updatedEpisode, error } = await supabase
      .from('episodes')
      .update(updatePayload)
      .eq('id', episodeId)
      .eq('story_id', storyId)
      .eq('user_id', userId)
      .select()
      .single()

    if (error) throw error

    if (status === 'published') {
      const { error: storyError } = await supabase
        .from('stories')
        .update({ status: 'published', updated_at: now })
        .eq('id', storyId)
        .eq('user_id', userId)

      if (storyError) throw storyError
    }

    return res.status(200).json({
      ok: true,
      message:
        status === 'published'
          ? 'Chat Story episode published successfully'
          : status === 'scheduled'
            ? 'Chat Story episode scheduled successfully'
            : 'Chat Story episode saved as draft',
      episode: updatedEpisode,
    })
  } catch (error) {
    console.error('UPDATE CHAT STORY EPISODE STATUS ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to update Chat Story episode status',
      error: error.message,
    })
  }
}

export async function updateEpisodeStatusByStoryType(req, res, next) {
  try {
    const userId = req.user?.user_id

    if (!userId) {
      return res.status(401).json({ ok: false, message: 'Unauthorized' })
    }

    const storyType = await getOwnedStoryType(req.params.storyId, userId)

    if (storyType === 'chat_story') {
      return updateChatStoryEpisodeStatus(req, res)
    }

    return updateEpisodeStatus(req, res, next)
  } catch (error) {
    console.error('ROUTE EPISODE STATUS BY STORY TYPE ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to resolve episode publish type',
      error: error.message,
    })
  }
}
