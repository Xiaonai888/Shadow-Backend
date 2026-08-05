import { supabase } from '../config/supabase.js'

const AUTHOR_PAGE_NOTIFICATION_TYPES = new Set([
  'comment',
  'reaction',
  'echo',
  'mention',
  'follower',
  'review',
  'order',
  'income',
  'system',
  'admin',
])

function cleanText(value, fallback = '') {
  return String(value ?? fallback).trim()
}

async function getAuthorPageOwner(authorPageId) {
  const { data, error } = await supabase
    .from('author_pages')
    .select('id, user_id')
    .eq('id', authorPageId)
    .eq('status', 'active')
    .maybeSingle()

  if (error) throw error
  return data || null
}

export async function createAuthorPageNotification({
  authorPageId,
  authorUserId = '',
  type = 'system',
  title,
  message = '',
  targetUrl = '',
  sourceKey = '',
  metadata = {},
}) {
  const cleanAuthorPageId = cleanText(authorPageId)
  const cleanTitle = cleanText(title)
  const cleanType = AUTHOR_PAGE_NOTIFICATION_TYPES.has(type)
    ? type
    : 'system'

  if (!cleanAuthorPageId || !cleanTitle) return null

  let cleanAuthorUserId = cleanText(authorUserId)

  if (!cleanAuthorUserId) {
    const authorPage = await getAuthorPageOwner(cleanAuthorPageId)
    cleanAuthorUserId = cleanText(authorPage?.user_id)
  }

  if (!cleanAuthorUserId) return null

  const cleanSourceKey = cleanText(sourceKey)
  const cleanMetadata =
    metadata && typeof metadata === 'object'
      ? { ...metadata }
      : {}

  if (cleanSourceKey) {
    cleanMetadata.source_key = cleanSourceKey

    const { data: existing, error: existingError } = await supabase
      .from('author_page_notifications')
      .select('*')
      .eq('author_page_id', cleanAuthorPageId)
      .eq('type', cleanType)
      .contains('metadata', { source_key: cleanSourceKey })
      .maybeSingle()

    if (existingError) throw existingError
    if (existing) return existing
  }

  const { data, error } = await supabase
    .from('author_page_notifications')
    .insert({
      author_page_id: cleanAuthorPageId,
      user_id: cleanAuthorUserId,
      type: cleanType,
      title: cleanTitle,
      message: cleanText(message),
      target_url: cleanText(targetUrl),
      metadata: cleanMetadata,
      is_read: false,
    })
    .select()
    .single()

  if (error) throw error
  return data
}

export async function createAuthorPageNotificationSafely(payload) {
  try {
    return await createAuthorPageNotification(payload)
  } catch (error) {
    console.error('CREATE AUTHOR PAGE NOTIFICATION ERROR:', error)
    return null
  }
}

export async function deleteAuthorPageNotificationBySourceKeySafely({
  authorPageId,
  type,
  sourceKey,
}) {
  try {
    const cleanAuthorPageId = cleanText(authorPageId)
    const cleanSourceKey = cleanText(sourceKey)
    const cleanType = AUTHOR_PAGE_NOTIFICATION_TYPES.has(type)
      ? type
      : ''

    if (!cleanAuthorPageId || !cleanSourceKey || !cleanType) return

    const { error } = await supabase
      .from('author_page_notifications')
      .delete()
      .eq('author_page_id', cleanAuthorPageId)
      .eq('type', cleanType)
      .contains('metadata', { source_key: cleanSourceKey })

    if (error) throw error
  } catch (error) {
    console.error('DELETE AUTHOR PAGE NOTIFICATION ERROR:', error)
  }
}
