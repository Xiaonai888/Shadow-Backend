import { supabase } from '../config/supabase.js'

const ALLOWED_ROLE_GROUPS = ['main', 'major', 'minor', 'background']
const ALLOWED_AVATAR_SOURCES = ['device', 'shadow_gallery']
const ALLOWED_CHAT_SIDES = ['left', 'right']
const ALLOWED_GENDERS = ['Female', 'Male', 'Non-binary', 'Unknown']
const MAX_CHARACTERS = 100

function cleanText(value) {
  return String(value || '').trim()
}

function cleanNullableText(value, max = 5000) {
  const text = cleanText(value).slice(0, max)
  return text || null
}

function cleanGender(value) {
  const gender = cleanText(value)
  return ALLOWED_GENDERS.includes(gender) ? gender : null
}

function cleanBirthday(value) {
  const birthday = cleanText(value)
  if (!birthday) return null

  const date = new Date(`${birthday}T00:00:00`)
  return Number.isNaN(date.getTime()) ? null : birthday
}

function cleanHeight(value) {
  if (value === null || value === undefined || value === '') return null

  const height = Math.floor(Number(value))
  return Number.isFinite(height) && height >= 1 && height <= 300 ? height : null
}

async function getOwnedChatStory(storyId, userId) {
  const { data, error } = await supabase
    .from('stories')
    .select('id, story_type')
    .eq('id', storyId)
    .eq('user_id', userId)
    .is('deleted_at', null)
    .maybeSingle()

  if (error) throw error
  return data
}

function normalizeCharacters(value, storyId, userId) {
  const counters = { main: 0, major: 0, minor: 0, background: 0 }

  return value.map((item) => {
    const roleGroup = cleanText(item?.role_group || item?.roleGroup).toLowerCase()
    const avatarSource = cleanText(item?.avatar_source || item?.avatarSource || 'device').toLowerCase()
    const requestedSide = cleanText(item?.chat_side || item?.chatSide).toLowerCase()
    const chatSide = ALLOWED_CHAT_SIDES.includes(requestedSide)
      ? requestedSide
      : roleGroup === 'main'
        ? 'right'
        : 'left'

    if (!ALLOWED_ROLE_GROUPS.includes(roleGroup)) return null

    const character = {
      story_id: storyId,
      user_id: userId,
      role_group: roleGroup,
      nickname: cleanNullableText(item?.nickname, 40),
      avatar_url: cleanNullableText(item?.avatar_url || item?.avatarUrl, 1000),
      avatar_source: ALLOWED_AVATAR_SOURCES.includes(avatarSource) ? avatarSource : 'device',
      chat_side: chatSide,
      sort_order: counters[roleGroup],
      gender: cleanGender(item?.gender),
      birthday: cleanBirthday(item?.birthday),
      height_cm: cleanHeight(item?.height_cm ?? item?.heightCm),
      occupation: cleanNullableText(item?.occupation, 120),
      personality: cleanNullableText(item?.personality, 300),
      relationship: cleanNullableText(item?.relationship, 300),
      bio: cleanNullableText(item?.bio, 5000),
    }

    counters[roleGroup] += 1
    return character
  })
}

export async function getChatStoryCharacters(req, res) {
  try {
    const userId = req.user?.user_id
    const { storyId } = req.params

    if (!userId) {
      return res.status(401).json({ ok: false, message: 'Unauthorized' })
    }

    const story = await getOwnedChatStory(storyId, userId)

    if (!story) {
      return res.status(404).json({ ok: false, message: 'Story not found' })
    }

    if (story.story_type !== 'chat_story') {
      return res.status(400).json({ ok: false, message: 'This story is not a Chat Story' })
    }

    const { data, error } = await supabase
      .from('chat_story_characters')
      .select('*')
      .eq('story_id', storyId)
      .eq('user_id', userId)
      .order('role_group', { ascending: true })
      .order('sort_order', { ascending: true })

    if (error) throw error

    return res.status(200).json({
      ok: true,
      characters: data || [],
    })
  } catch (error) {
    console.error('GET CHAT STORY CHARACTERS ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load Chat Story characters',
      error: error.message,
    })
  }
}

export async function saveChatStoryCharacters(req, res) {
  try {
    const userId = req.user?.user_id
    const { storyId } = req.params
    const input = req.body.characters

    if (!userId) {
      return res.status(401).json({ ok: false, message: 'Unauthorized' })
    }

    if (!Array.isArray(input)) {
      return res.status(400).json({ ok: false, message: 'Characters must be an array' })
    }

    if (input.length > MAX_CHARACTERS) {
      return res.status(400).json({ ok: false, message: `Maximum ${MAX_CHARACTERS} characters allowed` })
    }

    const story = await getOwnedChatStory(storyId, userId)

    if (!story) {
      return res.status(404).json({ ok: false, message: 'Story not found' })
    }

    if (story.story_type !== 'chat_story') {
      return res.status(400).json({ ok: false, message: 'This story is not a Chat Story' })
    }

    const characters = normalizeCharacters(input, storyId, userId)

    if (characters.some((character) => !character)) {
      return res.status(400).json({ ok: false, message: 'Invalid character role group' })
    }

    const missingNickname = characters.some(
      (character) => character.role_group !== 'background' && !character.nickname
    )

    if (missingNickname) {
      return res.status(400).json({
        ok: false,
        message: 'Main and supporting characters need a nickname',
      })
    }

    const { error: deleteError } = await supabase
      .from('chat_story_characters')
      .delete()
      .eq('story_id', storyId)
      .eq('user_id', userId)

    if (deleteError) throw deleteError

    if (characters.length === 0) {
      return res.status(200).json({
        ok: true,
        message: 'Characters saved successfully',
        characters: [],
      })
    }

    const { data, error: insertError } = await supabase
      .from('chat_story_characters')
      .insert(characters)
      .select()

    if (insertError) throw insertError

    return res.status(200).json({
      ok: true,
      message: 'Characters saved successfully',
      characters: data || [],
    })
  } catch (error) {
    console.error('SAVE CHAT STORY CHARACTERS ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to save Chat Story characters',
      error: error.message,
    })
  }
}
