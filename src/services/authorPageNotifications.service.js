import { supabase } from '../config/supabase.js'
import {
  deleteR2ObjectByUrl,
  uploadFileToR2,
} from './r2Storage.service.js'
import {
  assertNoForbiddenMediaReferences,
  isInlineMediaValue,
  isR2PublicUrl,
  isSupabaseStorageUrl,
} from './mediaStoragePolicy.service.js'
import {
  publishAuthorPageNotificationCreated,
} from './authorPageNotificationSse.service.js'

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

const NOTIFICATION_MEDIA_MAX_BYTES =
  5 * 1024 * 1024

function cleanText(value, fallback = '') {
  return String(value ?? fallback).trim()
}

function cleanMetadata(value) {
  return value && typeof value === 'object'
    ? { ...value }
    : {}
}

function mediaType(buffer) {
  if (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(
      Buffer.from([
        137, 80, 78, 71,
        13, 10, 26, 10,
      ])
    )
  ) {
    return {
      mimetype: 'image/png',
      extension: 'png',
    }
  }

  if (
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  ) {
    return {
      mimetype: 'image/jpeg',
      extension: 'jpg',
    }
  }

  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return {
      mimetype: 'image/webp',
      extension: 'webp',
    }
  }

  if (
    buffer.length >= 6 &&
    ['GIF87a', 'GIF89a'].includes(
      buffer.subarray(0, 6).toString('ascii')
    )
  ) {
    return {
      mimetype: 'image/gif',
      extension: 'gif',
    }
  }

  return null
}

function extensionFromMime(value) {
  const mime = cleanText(value)
    .toLowerCase()
    .split(';')[0]

  const map = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
  }

  return map[mime] || ''
}

function decodeInlineMedia(value) {
  const input = cleanText(value)
  const match = input.match(
    /^data:([^;,]+);base64,([\s\S]+)$/i
  )

  let mimetype = ''
  let encoded = ''

  if (match) {
    mimetype = cleanText(match[1])
    encoded = match[2]
  } else if (
    input.toLowerCase().startsWith('base64,')
  ) {
    encoded = input.slice(7)
  } else {
    return null
  }

  const normalized =
    encoded.replace(/\s+/g, '')

  if (
    normalized.length >
    7 * 1024 * 1024
  ) {
    return null
  }

  const buffer = Buffer.from(
    normalized,
    'base64'
  )

  if (
    !buffer.length ||
    buffer.length >
      NOTIFICATION_MEDIA_MAX_BYTES
  ) {
    return null
  }

  const detected = mediaType(buffer)
  const extension =
    detected?.extension ||
    extensionFromMime(mimetype)
  const finalMime =
    detected?.mimetype ||
    mimetype

  if (!extension || !finalMime) {
    return null
  }

  return {
    buffer,
    mimetype: finalMime,
    extension,
  }
}

function getMediaName(value, fallbackExtension) {
  try {
    const url = new URL(value)
    const name = decodeURIComponent(
      url.pathname.split('/').pop() || ''
    )

    if (name && name.includes('.')) {
      return name
    }
  } catch {}

  return `notification-media.${fallbackExtension}`
}

async function readSupabaseMedia(value) {
  let sourceUrl

  try {
    sourceUrl = new URL(value)
  } catch {
    return null
  }

  const configuredUrl =
    cleanText(process.env.SUPABASE_URL)

  if (!configuredUrl) return null

  let allowedOrigin

  try {
    allowedOrigin =
      new URL(configuredUrl).origin
  } catch {
    return null
  }

  if (
    sourceUrl.origin !== allowedOrigin
  ) {
    return null
  }

  try {
    const response = await fetch(sourceUrl)

    if (!response.ok) return null

    const contentLength =
      Number(
        response.headers.get(
          'content-length'
        ) || 0
      )

    if (
      contentLength >
      NOTIFICATION_MEDIA_MAX_BYTES
    ) {
      return null
    }

    const buffer = Buffer.from(
      await response.arrayBuffer()
    )

    if (
      !buffer.length ||
      buffer.length >
        NOTIFICATION_MEDIA_MAX_BYTES
    ) {
      return null
    }

    const detected = mediaType(buffer)
    const headerMime =
      cleanText(
        response.headers.get(
          'content-type'
        )
      ).split(';')[0]

    const extension =
      detected?.extension ||
      extensionFromMime(headerMime) ||
      cleanText(
        sourceUrl.pathname
          .split('.')
          .pop()
      ).toLowerCase()

    if (!extension) return null

    return {
      buffer,
      mimetype:
        detected?.mimetype ||
        headerMime ||
        'application/octet-stream',
      extension,
      originalname:
        getMediaName(
          value,
          extension
        ),
    }
  } catch (error) {
    console.warn(
      'READ AUTHOR PAGE NOTIFICATION MEDIA WARNING:',
      error.message
    )

    return null
  }
}

async function uploadNotificationMedia(
  media,
  authorPageId
) {
  return uploadFileToR2(
    {
      buffer: media.buffer,
      originalname:
        media.originalname ||
        `notification-media.${media.extension}`,
      mimetype: media.mimetype,
    },
    `author-page-notifications/${authorPageId}`
  )
}

async function sanitizeMediaString(
  value,
  context
) {
  const input = cleanText(value)

  if (!input) return value

  if (context.cache.has(input)) {
    return context.cache.get(input)
  }

  if (isR2PublicUrl(input)) {
    context.cache.set(input, input)
    return input
  }

  let media = null

  if (isSupabaseStorageUrl(input)) {
    media = await readSupabaseMedia(input)

    if (!media) {
      context.cache.set(input, null)
      return null
    }
  } else if (isInlineMediaValue(input)) {
    media = decodeInlineMedia(input)

    if (!media) {
      context.cache.set(input, null)
      return null
    }
  } else {
    return value
  }

  try {
    const url =
      await uploadNotificationMedia(
        media,
        context.authorPageId
      )

    context.uploadedUrls.add(url)
    context.cache.set(input, url)

    return url
  } catch (error) {
    console.warn(
      'UPLOAD AUTHOR PAGE NOTIFICATION MEDIA WARNING:',
      error.message
    )

    context.cache.set(input, null)
    return null
  }
}

async function sanitizeMetadata(
  value,
  context
) {
  if (typeof value === 'string') {
    return sanitizeMediaString(
      value,
      context
    )
  }

  if (Array.isArray(value)) {
    return Promise.all(
      value.map((item) =>
        sanitizeMetadata(
          item,
          context
        )
      )
    )
  }

  if (
    value &&
    typeof value === 'object'
  ) {
    const entries =
      await Promise.all(
        Object.entries(value).map(
          async ([key, item]) => [
            key,
            await sanitizeMetadata(
              item,
              context
            ),
          ]
        )
      )

    return Object.fromEntries(entries)
  }

  return value
}

async function cleanupUploadedMedia(
  uploadedUrls
) {
  for (const url of uploadedUrls) {
    try {
      await deleteR2ObjectByUrl(url)
    } catch (error) {
      console.warn(
        'AUTHOR PAGE NOTIFICATION MEDIA CLEANUP WARNING:',
        error.message
      )
    }
  }
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

  publishAuthorPageNotificationCreated({
    userId: authorUserId,
    notification: data,
  })

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
  const uploadedUrls = new Set()

  try {
    const cleanAuthorPageId =
      cleanText(authorPageId)
    const cleanTitle =
      cleanText(title)
    const requestedType =
      cleanText(
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

      cleanAuthorUserId =
        cleanText(
          authorPage?.user_id
        )
    }

    if (!cleanAuthorUserId) return null

    const preference =
      await getNotificationPreference({
        authorPageId:
          cleanAuthorPageId,
        type: cleanType,
      })

    if (!preference.isEnabled) {
      return null
    }

    const cleanSourceKey =
      cleanText(sourceKey)

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

    const cleanNotificationMetadata = {
      ...cleanMetadata(metadata),
      ...(cleanSourceKey
        ? {
            source_key:
              cleanSourceKey,
          }
        : {}),
    }

    const safeMetadata =
      await sanitizeMetadata(
        cleanNotificationMetadata,
        {
          authorPageId:
            cleanAuthorPageId,
          cache: new Map(),
          uploadedUrls,
        }
      )

    assertNoForbiddenMediaReferences(
      safeMetadata,
      'author_page_notifications.metadata'
    )

    const payload = {
      authorPageId: cleanAuthorPageId,
      authorUserId: cleanAuthorUserId,
      originalType: cleanType,
      title: cleanTitle,
      message: cleanText(message),
      targetUrl: cleanTargetUrl,
      metadata: safeMetadata,
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
  } catch (error) {
    await cleanupUploadedMedia(
      uploadedUrls
    )
    throw error
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
    const cleanAuthorPageId =
      cleanText(authorPageId)
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
      .from(
        'author_page_notifications'
      )
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
