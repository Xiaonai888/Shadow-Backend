import { supabase } from '../config/supabase.js'

const NOTIFICATION_TYPES = new Set([
  'comment',
  'like',
  'echo',
  'unlock',
  'income',
  'gift',
  'system',
])

const FREQUENCY_LEVELS = new Set(['more', 'normal', 'less'])
const FREQUENCY_TYPES = new Set(['comment', 'like', 'echo'])

function cleanText(value, fallback = '') {
  return String(value ?? fallback).trim()
}

async function shouldThrottleNotification({
  authorId,
  type,
  targetUrl,
  frequencyLevel,
}) {
  if (!FREQUENCY_TYPES.has(type) || frequencyLevel === 'more') return false

  const minutes = frequencyLevel === 'less' ? 60 : 5
  const since = new Date(Date.now() - minutes * 60 * 1000).toISOString()

  let query = supabase
    .from('author_story_notifications')
    .select('id')
    .eq('author_id', authorId)
    .eq('type', type)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(1)

  if (frequencyLevel === 'normal' && targetUrl) {
    query = query.eq('target_url', targetUrl)
  }

  const { data, error } = await query.maybeSingle()

  if (error) throw error
  return Boolean(data)
}

export async function createAuthorStoryNotification({
  authorId,
  authorUserId = '',
  type = 'system',
  title,
  message = '',
  targetUrl = '',
  sourceKey = '',
  metadata = {},
}) {
  const cleanAuthorId = cleanText(authorId)
  const cleanTitle = cleanText(title)
  const requestedType = cleanText(type, 'system').toLowerCase()
  const cleanType = NOTIFICATION_TYPES.has(requestedType) ? requestedType : 'system'
  const cleanTargetUrl = cleanText(targetUrl)

  if (!cleanAuthorId || !cleanTitle) return null

  let cleanAuthorUserId = cleanText(authorUserId)

  if (!cleanAuthorUserId) {
    const { data: authorPage, error: authorError } = await supabase
      .from('author_pages')
      .select('user_id')
      .eq('id', cleanAuthorId)
      .maybeSingle()

    if (authorError) throw authorError
    cleanAuthorUserId = cleanText(authorPage?.user_id)
  }

  if (!cleanAuthorUserId) return null

  const { data: preference, error: preferenceError } = await supabase
    .from('author_story_notification_preferences')
    .select('is_enabled, frequency_level')
    .eq('author_id', cleanAuthorId)
    .eq('type', cleanType)
    .maybeSingle()

  if (preferenceError) throw preferenceError
  if (preference?.is_enabled === false) return null

  const requestedFrequency = cleanText(
    preference?.frequency_level,
    'normal'
  ).toLowerCase()

  const frequencyLevel = FREQUENCY_LEVELS.has(requestedFrequency)
    ? requestedFrequency
    : 'normal'

  const shouldThrottle = await shouldThrottleNotification({
    authorId: cleanAuthorId,
    type: cleanType,
    targetUrl: cleanTargetUrl,
    frequencyLevel,
  })

  if (shouldThrottle) return null

  const row = {
    author_id: cleanAuthorId,
    author_user_id: cleanAuthorUserId,
    type: cleanType,
    title: cleanTitle,
    message: cleanText(message),
    target_url: cleanTargetUrl,
    source_key: cleanText(sourceKey) || null,
    metadata: metadata && typeof metadata === 'object' ? metadata : {},
    is_read: false,
  }

  let query = supabase
    .from('author_story_notifications')
    .insert(row)

  if (row.source_key) {
    query = supabase
      .from('author_story_notifications')
      .upsert(row, {
        onConflict: 'source_key',
        ignoreDuplicates: true,
      })
  }

  const { data, error } = await query.select().maybeSingle()

  if (error) throw error

  return data || null
}

export async function createAuthorStoryNotificationSafely(payload) {
  try {
    return await createAuthorStoryNotification(payload)
  } catch (error) {
    console.error('CREATE AUTHOR STORY NOTIFICATION ERROR:', error)
    return null
  }
}
