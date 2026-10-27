import { supabase } from '../config/supabase.js'
import { blockedWordsWarningPayload, findBlockedWordsInContent } from '../utils/blockedWords.js'
import { updateEpisodeStatus } from './stories.controller.js'

const MAX_MESSAGES = 1000
const MAX_MESSAGE_CHARACTERS = 2000
const MAX_TOTAL_CHARACTERS = 30000

function cleanText(value) {
  return String(value || '').trim()
}

function hasThaiCharacters(...values) {
  return values.some((value) => /[\u0E00-\u0E7F]/.test(String(value || '')))
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
    .select(
  'id, nickname, avatar_url, role_group, chat_side, sort_order, is_lead'
)
    .eq('story_id', storyId)
    .eq('user_id', userId)
    .order('sort_order', { ascending: true })

  if (error) throw error
  return data || []
}

function normalizeVoiceUrl(value, authorPageId) {
  try {
    const base = new URL(String(process.env.R2_PUBLIC_URL || '').replace(/\/+$/, '') + '/')
    const url = new URL(String(value || '').trim())
    const prefix = `${base.pathname}chat-story/audio/${authorPageId}/`
    if (!authorPageId || base.protocol !== 'https:' || url.protocol !== 'https:' ||
      url.origin !== base.origin || url.username || url.password || url.search || url.hash ||
      !url.pathname.startsWith(prefix)) return null
    const name = url.pathname.slice(prefix.length)
    if (!/^[0-9]+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(mp3|m4a|aac|wav|webm)$/i.test(name)) return null
    return url.href
  } catch {
    return null
  }
}

function normalizeMessages(input, characterIds, audioOwnerId = '') {
  if (!Array.isArray(input)) return { error: 'Messages must be an array', messages: [] }
  if (input.length > MAX_MESSAGES) {
    return { error: `Maximum ${MAX_MESSAGES} messages allowed in one episode`, messages: [] }
  }

  const messages = []
  let authorNoteCount = 0

  for (let index = 0; index < input.length; index += 1) {
    const item = input[index] || {}
    const requestedType = cleanText(item.type).toLowerCase()
const type = requestedType === 'voice' ? 'audio' : ['chat', 'aside', 'author_note', 'image', 'audio', 'notification'].includes(requestedType)
  ? requestedType
  : 'aside'
const text = cleanText(item.text)
const imageUrl = cleanNullableText(item.image_url || item.imageUrl)
const characterId = cleanNullableText(item.character_id || item.characterId)
if (type === 'image' && !imageUrl) continue
if (type === 'notification' && !text) return { error: 'Notification text is required', messages: [] }
if (type !== 'image' && type !== 'audio' && !text) continue
const audioUrl = type === 'audio' ? normalizeVoiceUrl(item.audio_url || item.audioUrl || item.voice_url || item.voiceUrl, audioOwnerId) : null
const audioDuration = type === 'audio' ? Number(item.audio_duration ?? item.audioDuration ?? item.duration_seconds ?? item.duration) : null
if (type === 'audio' && !audioUrl) return { error: 'Voice must be uploaded to this author account before saving', messages: [] }
if (type === 'audio' && (!Number.isFinite(audioDuration) || audioDuration < 1 || audioDuration > 60))
  return { error: 'Voice duration must be from 1 to 60 seconds', messages: [] }
if (type === 'audio' && (!characterId || !characterIds.has(characterId)))
  return { error: 'The selected voice character is invalid', messages: [] }
    if (type === 'author_note') {
  authorNoteCount += 1

  if (authorNoteCount > 1) {
    return {
      error: 'Only one Author’s Note is allowed in one episode',
      messages: [],
    }
  }
}
    if (text.length > MAX_MESSAGE_CHARACTERS) {
      return {
        error: `Each message must be ${MAX_MESSAGE_CHARACTERS} characters or less`,
        messages: [],
      }
    }
    if (type === 'chat' && (!characterId || !characterIds.has(characterId))) {
  return { error: 'One or more selected characters are invalid', messages: [] }
}
if (type === 'image' && characterId && !characterIds.has(characterId)) {
  return { error: 'The selected image character is invalid', messages: [] }
}

let notification = null
if (type === 'notification') {
  if (!characterId || !characterIds.has(characterId)) {
    return { error: 'Choose a valid character for the notification', messages: [] }
  }
  if (text.length > 500) {
    return { error: 'Notification text must be 500 characters or less', messages: [] }
  }
  if (imageUrl && (!/^https:\/\/[^\s]+$/i.test(imageUrl) || imageUrl.length > 2048)) {
    return { error: 'Notification image must be a valid HTTPS URL', messages: [] }
  }
  const options = item.notification && typeof item.notification === 'object' && !Array.isArray(item.notification)
    ? item.notification
    : {}
  const dismissMode = cleanText(options.dismiss_mode ?? options.dismissMode ?? 'duration').toLowerCase()
  if (!['duration', 'swipe', 'next'].includes(dismissMode)) {
    return { error: 'Invalid notification dismissal mode', messages: [] }
  }
  const durationSeconds = Number(options.duration_seconds ?? options.durationSeconds ?? 4)
  if (!Number.isInteger(durationSeconds) || durationSeconds < 1 || durationSeconds > 30) {
    return { error: 'Notification duration must be between 1 and 30 seconds', messages: [] }
  }
  const rawSwipe = options.swipe_to_dismiss ?? options.swipeToDismiss
  if (rawSwipe !== undefined && typeof rawSwipe !== 'boolean') {
    return { error: 'Invalid notification swipe setting', messages: [] }
  }
  notification = {
    dismiss_mode: dismissMode,
    duration_seconds: durationSeconds,
    swipe_to_dismiss: dismissMode === 'swipe' || rawSwipe !== false,
  }
}

    messages.push({
  id: cleanText(item.id) || `${Date.now()}-${index}`,
  type,
  character_id: ['chat', 'image', 'audio', 'notification'].includes(type) ? characterId : null,
  text: type === 'image' || type === 'audio' ? '' : text,
  image_url: ['image', 'notification'].includes(type) ? imageUrl : null,
  ...(notification ? { notification } : {}),
  ...(type === 'audio' ? { audio_url: audioUrl, audio_duration: audioDuration } : {}),
  sort_order: messages.length,
  created_at: cleanNullableText(item.created_at || item.createdAt),
})
  }

  if (!messages.some((message) => message.type !== 'author_note')) {
  return {
    error: 'Add at least one Chat or ASIDE message',
    messages: [],
  }
}

const authorNote = messages.find(
  (message) => message.type === 'author_note'
)

const orderedMessages = [
  ...messages.filter((message) => message.type !== 'author_note'),
  ...(authorNote ? [authorNote] : []),
].map((message, index) => ({
  ...message,
  sort_order: index,
}))

const totalCharacters = orderedMessages.reduce(
  (sum, message) => sum + message.text.length,
  0
)

if (totalCharacters > MAX_TOTAL_CHARACTERS) {
  return {
    error: `Chat episode must be ${MAX_TOTAL_CHARACTERS} text characters or less`,
    messages: [],
  }
}

return {
  error: '',
  messages: orderedMessages,
  totalCharacters,
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
    const characterIds = new Set(
  characters.map(
    (character) =>
      String(character.id)
  )
)

const requestedLeadCharacterId =
  cleanNullableText(
    req.body.lead_character_id ||
      req.body.leadCharacterId
  )

const defaultLeadCharacter =
  characters.find(
    (character) =>
      character.is_lead === true
  ) ||
  characters.find(
    (character) =>
      character.chat_side === 'right'
  ) ||
  characters[0] ||
  null

const leadCharacterId =
  requestedLeadCharacterId &&
  characterIds.has(
    requestedLeadCharacterId
  )
    ? requestedLeadCharacterId
    : defaultLeadCharacter?.id || null

let audioOwnerId = ''
if (Array.isArray(req.body.messages) && req.body.messages.length <= MAX_MESSAGES &&
  req.body.messages.some((item) => ['audio', 'voice'].includes(cleanText(item?.type).toLowerCase()))) {
  const { data: page, error: pageError } = await supabase.from('author_pages')
    .select('id').eq('user_id', userId).eq('status', 'active').maybeSingle()
  if (pageError) throw pageError
  if (!page) return res.status(403).json({ ok: false, message: 'An active author page is required to save voice messages' })
  audioOwnerId = String(page.id)
}
const normalized = normalizeMessages(
  req.body.messages,
  characterIds,
  audioOwnerId
)

    if (normalized.error) {
      return res.status(400).json({ ok: false, message: normalized.error })
    }

    const hasNotifications = normalized.messages.some((message) => message.type === 'notification')
    let notificationSettings = null
    if (hasNotifications) {
      const options = req.body.notification_settings ?? req.body.notificationSettings ?? {}
      if (!options || typeof options !== 'object' || Array.isArray(options)) {
        return res.status(400).json({ ok: false, message: 'Invalid notification settings' })
      }
      const maxVisible = Number(options.max_visible ?? options.maxVisible ?? 2)
      if (!Number.isInteger(maxVisible) || maxVisible < 1 || maxVisible > 3) {
        return res.status(400).json({ ok: false, message: 'Maximum visible notifications must be 1 to 3' })
      }
      notificationSettings = { max_visible: maxVisible }
    }

    const plainText = normalized.messages
  .map((message) => message.text)
  .join('\n')

const storyPlainText = normalized.messages
  .filter((message) => message.type !== 'author_note')
  .map((message) => message.text)
  .join('\n')
    const hasRequestedCharacterIds =
  Array.isArray(req.body.character_ids) ||
  Array.isArray(req.body.characterIds)

const requestedCharacterIdsInput =
  Array.isArray(req.body.character_ids)
    ? req.body.character_ids
    : Array.isArray(req.body.characterIds)
      ? req.body.characterIds
      : []

const requestedCharacterIds = [
  ...new Set(
    requestedCharacterIdsInput
      .map((value) => cleanText(value))
      .filter(Boolean)
  ),
]

const invalidCharacterIds =
  requestedCharacterIds.filter(
    (characterId) =>
      !characterIds.has(characterId)
  )

if (invalidCharacterIds.length) {
  return res.status(400).json({
    ok: false,
    message:
      'One or more selected episode characters are invalid',
  })
}

const episodeCharacterIds =
  new Set(requestedCharacterIds)

for (const message of normalized.messages) {
  if (message.character_id) {
    episodeCharacterIds.add(
      String(message.character_id)
    )
  }
}

if (leadCharacterId) {
  episodeCharacterIds.add(
    String(leadCharacterId)
  )
}

const episodeCharacters =
  hasRequestedCharacterIds
    ? characters.filter((character) =>
        episodeCharacterIds.has(
          String(character.id)
        )
      )
    : characters

const content = JSON.stringify({
  format: 'shadow_chat_story_v1',
  version: 1,
  story_id: storyId,
  episode_title: title,
  lead_character_id: leadCharacterId,
  characters: episodeCharacters.map(
    (character) => ({
      id: character.id,
      nickname: character.nickname || '',
      avatar_url: character.avatar_url || '',
      role_group: character.role_group,
      is_lead:
        character.is_lead === true,
      chat_side: character.chat_side,
      sort_order: character.sort_order,
    })
  ),
  messages: normalized.messages,
  ...(notificationSettings ? { notification_settings: notificationSettings } : {}),
})

    const requestedEpisodeId = cleanNullableText(req.body.episode_id || req.body.episodeId)
    const existingEpisode = await getOwnedEpisode(storyId, requestedEpisodeId, userId)
    const checkpoint = req.body.checkpoint === true
    const expectedUpdatedAt = cleanNullableText(req.body.expected_updated_at)
    const clientEpisodeId = cleanNullableText(req.body.client_episode_id)
    if (requestedEpisodeId && !existingEpisode) {
      return res.status(404).json({ ok: false, message: 'Episode not found' })
    }
    if (checkpoint && !existingEpisode) {
      return res.status(400).json({ ok: false, message: 'Save the new episode before automatic server backup' })
    }
    if (clientEpisodeId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clientEpisodeId)) {
      return res.status(400).json({ ok: false, message: 'Invalid draft identifier' })
    }
    if (!requestedEpisodeId && clientEpisodeId) {
      const previous = await getOwnedEpisode(storyId, clientEpisodeId, userId)
      if (previous) {
        return res.status(200).json({ ok: true, episode: previous, is_first_episode: Number(previous.episode_number || 0) === 1 })
      }
    }
    if (existingEpisode && expectedUpdatedAt && existingEpisode.updated_at !== expectedUpdatedAt) {
      return res.status(409).json({ ok: false, code: 'DRAFT_VERSION_CONFLICT', message: 'A newer episode version exists. Reload before saving.' })
    }
    const now = new Date().toISOString()
    const episodeNumber = existingEpisode?.episode_number || await getNextEpisodeNumber(storyId)
    const payload = {
      title,
      content,
      status: existingEpisode?.status || 'ready',
      published_at: existingEpisode?.published_at || null,
      is_locked:
        typeof req.body.is_locked === 'boolean'
          ? req.body.is_locked
          : typeof req.body.isLocked === 'boolean'
            ? req.body.isLocked
            : existingEpisode?.is_locked ?? true,
      character_count: normalized.totalCharacters,
      word_count: calculateWordCount(storyPlainText),
      page_count: 0,
      updated_at: now,
    }

    let episode

    if (existingEpisode) {
      let updateQuery = supabase
        .from('episodes')
        .update(payload)
        .eq('id', existingEpisode.id)
        .eq('story_id', storyId)
        .eq('user_id', userId)
      updateQuery = existingEpisode.updated_at
        ? updateQuery.eq('updated_at', existingEpisode.updated_at)
        : updateQuery.is('updated_at', null)
      const { data, error } = await updateQuery.select().maybeSingle()
      if (error) throw error
      if (!data) {
        return res.status(409).json({ ok: false, code: 'DRAFT_VERSION_CONFLICT', message: 'A newer episode version exists. Reload before saving.' })
      }
      episode = data
    } else {
      const { data, error } = await supabase
        .from('episodes')
        .insert({
          ...(clientEpisodeId ? { id: clientEpisodeId } : {}),
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

      if (error?.code === '23505' && clientEpisodeId) {
        const previous = await getOwnedEpisode(storyId, clientEpisodeId, userId)
        if (previous) {
          return res.status(200).json({ ok: true, episode: previous, is_first_episode: Number(previous.episode_number || 0) === 1 })
        }
      }
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

    const storySettings = Array.isArray(story.story_settings)
  ? story.story_settings.filter((item) => String(item || '').trim())
  : []

if (['published', 'scheduled'].includes(status) && storySettings.length < 1) {
  return res.status(400).json({ ok: false, message: 'Choose at least 1 Story Setting' })
}

    const plainText = chatContent.messages
      .map((message) => cleanText(message.text))
      .filter(Boolean)
      .join('\n')

    if (['published', 'scheduled'].includes(status)) {
      if (
        hasThaiCharacters(
          story.title,
          story.description,
          episode.title,
          plainText
        )
      ) {
        return res.status(422).json({
          ok: false,
          code: 'THAI_CHARACTERS_FOUND',
          message: 'មិនអាចបោះផ្សាយបានទេ។ មាតិកានេះមានអក្សរភាសាថៃ។ សូមលុប ឬកែអក្សរថៃចេញសិន។',
        })
      }

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
  is_free_published: Boolean(
    req.body.is_free_published ??
      req.body.isFreePublished
  ),
  updated_at: now,
}

    if (status === 'published') {
  updatePayload.published_at =
  episode.published_at || now
updatePayload.first_published_at = episode.first_published_at || updatePayload.published_at
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
      updatePayload.published_at = episode.published_at || null
    }

    if (status === 'draft') {
      updatePayload.scheduled_at = null
      updatePayload.published_at = episode.published_at || null
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

