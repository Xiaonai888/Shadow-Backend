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

const FREQUENCY_LEVELS = new Set([
  'more',
  'normal',
  'less',
])

const FREQUENCY_TYPES = new Set([
  'comment',
  'reaction',
  'echo',
  'mention',
  'follower',
  'review',
])

function cleanText(value, fallback = '') {
  return String(value ?? fallback).trim()
}

function cleanMetadata(value) {
  return value && typeof value === 'object'
    ? { ...value }
    : {}
}

function getEffectiveType(item) {
  const metadata = cleanMetadata(item?.metadata)

  return cleanText(
    metadata.notification_type ||
      item?.type ||
      'system'
  ).toLowerCase()
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

async function getNotificationPreference({
  authorPageId,
  type,
}) {
  const { data, error } = await supabase
    .from(
      'author_page_notification_preferences'
    )
    .select(
      'is_enabled, frequency_level'
    )
    .eq('author_page_id', authorPageId)
    .eq('type', type)
    .maybeSingle()

  if (error) throw error

  const requestedFrequency = cleanText(
    data?.frequency_level,
    'normal'
  ).toLowerCase()

  return {
    isEnabled: data?.is_enabled !== false,
    frequencyLevel:
      FREQUENCY_LEVELS.has(
        requestedFrequency
      )
        ? requestedFrequency
        : 'normal',
  }
}

async function shouldThrottleNotification({
  authorPageId,
  type,
  targetUrl,
  frequencyLevel,
}) {
  if (
    !FREQUENCY_TYPES.has(type) ||
    frequencyLevel === 'more'
  ) {
    return false
  }

  const minutes =
    frequencyLevel === 'less' ? 60 : 5
  const since = new Date(
    Date.now() - minutes * 60 * 1000
  ).toISOString()
  const candidateTypes =
    type === 'system'
      ? ['system']
      : [type, 'system']

  let query = supabase
    .from('author_page_notifications')
    .select(
      'id, type, target_url, metadata, created_at'
    )
    .eq('author_page_id', authorPageId)
    .in('type', candidateTypes)
    .gte('created_at', since)
    .order('created_at', {
      ascending: false,
    })
    .limit(100)

  if (
    frequencyLevel === 'normal' &&
    targetUrl
  ) {
    query = query.eq(
      'target_url',
      targetUrl
    )
  }

  const { data, error } = await query

  if (error) throw error

  return (data || []).some(
    (item) => getEffectiveType(item) === type
  )
}

async function findNotificationBySourceKey({
  authorPageId,
  type,
  sourceKey,
}) {
  if (!sourceKey) return null

  const candidateTypes =
    type === 'system'
      ? ['system']
      : [type, 'system']

  const { data, error } = await supabase
    .from('author_page_notifications')
    .select('*')
    .eq('author_page_id', authorPageId)
    .in('type', candidateTypes)
    .order('created_at', {
      ascending: false,
    })
    .limit(200)

  if (error) throw error

  return (
    (data || []).find((item) => {
      const metadata = cleanMetadata(
        item.metadata
      )

      return (
        cleanText(metadata.source_key) ===
          sourceKey &&
        getEffectiveType(item) === type
      )
    }) || null
  )
}

async function insertNotification({
  authorPageId,
  authorUserId,
  storedType,
  originalType,
  title,
  message,
  targetUrl,
  metadata,
}) {
  const { data, error } = await supabase
    .from('author_page_notifications')
    .insert({
      author_page_id: authorPageId,
      user_id: authorUserId,
      type: storedType,
      title,
      message,
      target_url: targetUrl,
      metadata: {
        ...metadata,
        notification_type: originalType,
      },
      is_read: false,
    })
    .select()
    .single()

  if (error) throw error

  return data
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
  const cleanAuthorPageId = cleanText(
    authorPageId
  )
  const cleanTitle = cleanText(title)
  const requestedType = cleanText(
    type,
    'system'
  ).toLowerCase()
  const cleanType =
    AUTHOR_PAGE_NOTIFICATION_TYPES.has(
      requestedType
    )
      ? requestedType
      : 'system'
  const cleanTargetUrl =
    cleanText(targetUrl)

  if (!cleanAuthorPageId || !cleanTitle) {
    return null
  }

  let cleanAuthorUserId =
    cleanText(authorUserId)

  if (!cleanAuthorUserId) {
    const authorPage =
      await getAuthorPageOwner(
        cleanAuthorPageId
      )

    cleanAuthorUserId = cleanText(
      authorPage?.user_id
    )
  }

  if (!cleanAuthorUserId) return null

  const preference =
    await getNotificationPreference({
      authorPageId: cleanAuthorPageId,
      type: cleanType,
    })

  if (!preference.isEnabled) return null

  const cleanSourceKey =
    cleanText(sourceKey)
  const cleanNotificationMetadata = {
    ...cleanMetadata(metadata),
    ...(cleanSourceKey
      ? {
          source_key: cleanSourceKey,
        }
      : {}),
  }

  if (cleanSourceKey) {
    const existing =
      await findNotificationBySourceKey({
        authorPageId:
          cleanAuthorPageId,
        type: cleanType,
        sourceKey: cleanSourceKey,
      })

    if (existing) return existing
  }

  const shouldThrottle =
    await shouldThrottleNotification({
      authorPageId:
        cleanAuthorPageId,
      type: cleanType,
      targetUrl: cleanTargetUrl,
      frequencyLevel:
        preference.frequencyLevel,
    })

  if (shouldThrottle) return null

  const payload = {
    authorPageId: cleanAuthorPageId,
    authorUserId: cleanAuthorUserId,
    originalType: cleanType,
    title: cleanTitle,
    message: cleanText(message),
    targetUrl: cleanTargetUrl,
    metadata:
      cleanNotificationMetadata,
  }

  try {
    return await insertNotification({
      ...payload,
      storedType: cleanType,
    })
  } catch (error) {
    if (cleanType === 'system') {
      throw error
    }

    console.warn(
      `AUTHOR PAGE NOTIFICATION TYPE FALLBACK: ${cleanType}`,
      error
    )

    return insertNotification({
      ...payload,
      storedType: 'system',
    })
  }
}

export async function createAuthorPageNotificationSafely(
  payload
) {
  try {
    return await createAuthorPageNotification(
      payload
    )
  } catch (error) {
    console.error(
      'CREATE AUTHOR PAGE NOTIFICATION ERROR:',
      {
        message: error?.message || '',
        code: error?.code || '',
        details: error?.details || '',
        hint: error?.hint || '',
        payload,
      }
    )

    return null
  }
}

export async function deleteAuthorPageNotificationBySourceKeySafely({
  authorPageId,
  type,
  sourceKey,
}) {
  try {
    const cleanAuthorPageId = cleanText(
      authorPageId
    )
    const cleanSourceKey =
      cleanText(sourceKey)
    const requestedType = cleanText(
      type
    ).toLowerCase()
    const cleanType =
      AUTHOR_PAGE_NOTIFICATION_TYPES.has(
        requestedType
      )
        ? requestedType
        : ''

    if (
      !cleanAuthorPageId ||
      !cleanSourceKey ||
      !cleanType
    ) {
      return
    }

    const candidateTypes =
      cleanType === 'system'
        ? ['system']
        : [cleanType, 'system']

    const { data, error } = await supabase
      .from('author_page_notifications')
      .select(
        'id, type, metadata'
      )
      .eq(
        'author_page_id',
        cleanAuthorPageId
      )
      .in('type', candidateTypes)
      .order('created_at', {
        ascending: false,
      })
      .limit(200)

    if (error) throw error

    const matchingIds = (data || [])
      .filter((item) => {
        const itemMetadata =
          cleanMetadata(item.metadata)

        return (
          cleanText(
            itemMetadata.source_key
          ) === cleanSourceKey &&
          getEffectiveType(item) ===
            cleanType
        )
      })
      .map((item) => item.id)
      .filter(Boolean)

    if (!matchingIds.length) return

    const { error: deleteError } =
      await supabase
        .from(
          'author_page_notifications'
        )
        .delete()
        .in('id', matchingIds)

    if (deleteError) throw deleteError
  } catch (error) {
    console.error(
      'DELETE AUTHOR PAGE NOTIFICATION ERROR:',
      {
        message: error?.message || '',
        code: error?.code || '',
        details: error?.details || '',
        hint: error?.hint || '',
        authorPageId,
        type,
        sourceKey,
      }
    )
  }
}
