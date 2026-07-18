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

function cleanText(value, fallback = '') {
  return String(value ?? fallback).trim()
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
  const cleanType = NOTIFICATION_TYPES.has(type) ? type : 'system'

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
    .select('is_enabled')
    .eq('author_id', cleanAuthorId)
    .eq('type', cleanType)
    .maybeSingle()

  if (preferenceError) throw preferenceError
  if (preference?.is_enabled === false) return null

  const row = {
    author_id: cleanAuthorId,
    author_user_id: cleanAuthorUserId,
    type: cleanType,
    title: cleanTitle,
    message: cleanText(message),
    target_url: cleanText(targetUrl),
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
