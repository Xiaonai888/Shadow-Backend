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

const NOTIFICATION_TYPES = new Set([
  'comment',
  'like',
  'echo',
  'unlock',
  'income',
  'gift',
  'system',
])

const FREQUENCY_LEVELS = new Set([
  'more',
  'normal',
  'less',
])

const FREQUENCY_TYPES = new Set([
  'comment',
  'like',
  'echo',
])

const NOTIFICATION_MEDIA_MAX_BYTES =
  5 * 1024 * 1024

function cleanText(value, fallback = '') {
  return String(value ?? fallback).trim()
}

function notificationMediaType(buffer) {
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
    buffer
      .subarray(0, 4)
      .toString('ascii') === 'RIFF' &&
    buffer
      .subarray(8, 12)
      .toString('ascii') === 'WEBP'
  ) {
    return {
      mimetype: 'image/webp',
      extension: 'webp',
    }
  }

  if (
    buffer.length >= 6 &&
    ['GIF87a', 'GIF89a'].includes(
      buffer
        .subarray(0, 6)
        .toString('ascii')
    )
  ) {
    return {
      mimetype: 'image/gif',
      extension: 'gif',
    }
  }

  if (
    buffer.length >= 5 &&
    buffer
      .subarray(0, 5)
      .toString('ascii') === '%PDF-'
  ) {
    return {
      mimetype: 'application/pdf',
      extension: 'pdf',
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
    'application/pdf': 'pdf',
    'audio/mpeg': 'mp3',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'video/mp4': 'mp4',
  }

  return map[mime] || ''
}

function decodeInlineNotificationMedia(value) {
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

  const detected =
    notificationMediaType(buffer)

  const extension =
    detected?.extension ||
    extensionFromMime(mimetype)

  const finalMime =
    detected?.mimetype ||
    mimetype

  if (
    !extension ||
    !finalMime
  ) {
    return null
  }

  return {
    buffer,
    mimetype: finalMime,
    extension,
  }
}

function getNotificationMediaName(
  value,
  fallbackExtension
) {
  try {
    const url = new URL(value)
    const name = decodeURIComponent(
      url.pathname
        .split('/')
        .pop() ||
      ''
    )

    if (
      name &&
      name.includes('.')
    ) {
      return name
    }
  } catch {}

  return `notification-media.${fallbackExtension}`
}

async function readSupabaseNotificationMedia(
  value
) {
  let sourceUrl

  try {
    sourceUrl = new URL(value)
  } catch {
    return null
  }

  const configuredUrl =
    cleanText(
      process.env.SUPABASE_URL
    )

  if (!configuredUrl) {
    return null
  }

  let allowedOrigin

  try {
    allowedOrigin =
      new URL(
        configuredUrl
      ).origin
  } catch {
    return null
  }

  if (
    sourceUrl.origin !==
    allowedOrigin
  ) {
    return null
  }

  try {
    const response =
      await fetch(sourceUrl)

    if (!response.ok) {
      return null
    }

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

    const buffer =
      Buffer.from(
        await response.arrayBuffer()
      )

    if (
      !buffer.length ||
      buffer.length >
        NOTIFICATION_MEDIA_MAX_BYTES
    ) {
      return null
    }

    const detected =
      notificationMediaType(
        buffer
      )

    const headerMime =
      cleanText(
        response.headers.get(
          'content-type'
        )
      ).split(';')[0]

    const extension =
      detected?.extension ||
      extensionFromMime(
        headerMime
      ) ||
      cleanText(
        sourceUrl.pathname
          .split('.')
          .pop()
      ).toLowerCase()

    if (!extension) {
      return null
    }

    return {
      buffer,
      mimetype:
        detected?.mimetype ||
        headerMime ||
        'application/octet-stream',
      extension,
      originalname:
        getNotificationMediaName(
          value,
          extension
        ),
    }
  } catch (error) {
    console.warn(
      'READ NOTIFICATION MEDIA WARNING:',
      error.message
    )

    return null
  }
}

async function uploadNotificationMedia(
  media,
  authorId
) {
  return uploadFileToR2(
    {
      buffer: media.buffer,
      originalname:
        media.originalname ||
        `notification-media.${media.extension}`,
      mimetype:
        media.mimetype,
    },
    `author-notifications/${authorId}`
  )
}

async function sanitizeNotificationMediaString(
  value,
  context
) {
  const input = cleanText(value)

  if (!input) return value
  if (context.cache.has(input)) {
    return context.cache.get(input)
  }

  if (isR2PublicUrl(input)) {
    context.cache.set(
      input,
      input
    )

    return input
  }

  let media = null

  if (
    isSupabaseStorageUrl(
      input
    )
  ) {
    media =
      await readSupabaseNotificationMedia(
        input
      )

    if (!media) {
      context.cache.set(
        input,
        null
      )

      return null
    }
  } else if (
    isInlineMediaValue(
      input
    )
  ) {
    media =
      decodeInlineNotificationMedia(
        input
      )

    if (!media) {
      context.cache.set(
        input,
        null
      )

      return null
    }
  } else {
    return value
  }

  try {
    const url =
      await uploadNotificationMedia(
        media,
        context.authorId
      )

    context.uploadedUrls.add(
      url
    )

    context.cache.set(
      input,
      url
    )

    return url
  } catch (error) {
    console.warn(
      'UPLOAD NOTIFICATION MEDIA WARNING:',
      error.message
    )

    context.cache.set(
      input,
      null
    )

    return null
  }
}

async function sanitizeNotificationMetadata(
  value,
  context
) {
  if (typeof value === 'string') {
    return sanitizeNotificationMediaString(
      value,
      context
    )
  }

  if (Array.isArray(value)) {
    return Promise.all(
      value.map(
        (item) =>
          sanitizeNotificationMetadata(
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
            await sanitizeNotificationMetadata(
              item,
              context
            ),
          ]
        )
      )

    return Object.fromEntries(
      entries
    )
  }

  return value
}

async function cleanupNotificationMedia(
  uploadedUrls
) {
  for (const url of uploadedUrls) {
    try {
      await deleteR2ObjectByUrl(
        url
      )
    } catch (error) {
      console.warn(
        'NOTIFICATION MEDIA CLEANUP WARNING:',
        error.message
      )
    }
  }
}

async function shouldThrottleNotification({
  authorId,
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
    frequencyLevel === 'less'
      ? 60
      : 5

  const since =
    new Date(
      Date.now() -
      minutes * 60 * 1000
    ).toISOString()

  let query =
    supabase
      .from(
        'author_story_notifications'
      )
      .select('id')
      .eq(
        'author_id',
        authorId
      )
      .eq(
        'type',
        type
      )
      .gte(
        'created_at',
        since
      )
      .order(
        'created_at',
        {
          ascending: false,
        }
      )
      .limit(1)

  if (
    frequencyLevel === 'normal' &&
    targetUrl
  ) {
    query =
      query.eq(
        'target_url',
        targetUrl
      )
  }

  const {
    data,
    error,
  } = await query.maybeSingle()

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
  const uploadedUrls =
    new Set()

  try {
    const cleanAuthorId =
      cleanText(authorId)

    const cleanTitle =
      cleanText(title)

    const requestedType =
      cleanText(
        type,
        'system'
      ).toLowerCase()

    const cleanType =
      NOTIFICATION_TYPES.has(
        requestedType
      )
        ? requestedType
        : 'system'

    const cleanTargetUrl =
      cleanText(targetUrl)

    if (
      !cleanAuthorId ||
      !cleanTitle
    ) {
      return null
    }

    let cleanAuthorUserId =
      cleanText(
        authorUserId
      )

    if (!cleanAuthorUserId) {
      const {
        data: authorPage,
        error: authorError,
      } = await supabase
        .from('author_pages')
        .select('user_id')
        .eq(
          'id',
          cleanAuthorId
        )
        .maybeSingle()

      if (authorError) {
        throw authorError
      }

      cleanAuthorUserId =
        cleanText(
          authorPage?.user_id
        )
    }

    if (!cleanAuthorUserId) {
      return null
    }

    const {
      data: preference,
      error: preferenceError,
    } = await supabase
      .from(
        'author_story_notification_preferences'
      )
      .select(
        'is_enabled, frequency_level'
      )
      .eq(
        'author_id',
        cleanAuthorId
      )
      .eq(
        'type',
        cleanType
      )
      .maybeSingle()

    if (preferenceError) {
      throw preferenceError
    }

    if (
      preference?.is_enabled === false
    ) {
      return null
    }

    const requestedFrequency =
      cleanText(
        preference
          ?.frequency_level,
        'normal'
      ).toLowerCase()

    const frequencyLevel =
      FREQUENCY_LEVELS.has(
        requestedFrequency
      )
        ? requestedFrequency
        : 'normal'

    const shouldThrottle =
      await shouldThrottleNotification({
        authorId:
          cleanAuthorId,
        type:
          cleanType,
        targetUrl:
          cleanTargetUrl,
        frequencyLevel,
      })

    if (shouldThrottle) {
      return null
    }

    const metadataInput =
      metadata &&
      typeof metadata ===
        'object'
        ? metadata
        : {}

    const safeMetadata =
      await sanitizeNotificationMetadata(
        metadataInput,
        {
          authorId:
            cleanAuthorId,
          cache:
            new Map(),
          uploadedUrls,
        }
      )

    assertNoForbiddenMediaReferences(
      safeMetadata,
      'author_story_notifications.metadata'
    )

    const row = {
      author_id:
        cleanAuthorId,
      author_user_id:
        cleanAuthorUserId,
      type:
        cleanType,
      title:
        cleanTitle,
      message:
        cleanText(message),
      target_url:
        cleanTargetUrl,
      source_key:
        cleanText(
          sourceKey
        ) || null,
      metadata:
        safeMetadata,
      is_read: false,
    }

    let query =
      supabase
        .from(
          'author_story_notifications'
        )
        .insert(row)

    if (row.source_key) {
      query =
        supabase
          .from(
            'author_story_notifications'
          )
          .upsert(
            row,
            {
              onConflict:
                'source_key',
              ignoreDuplicates:
                true,
            }
          )
    }

    const {
      data,
      error,
    } =
      await query
        .select()
        .maybeSingle()

    if (error) throw error

    if (!data) {
      await cleanupNotificationMedia(
        uploadedUrls
      )

      return null
    }

    uploadedUrls.clear()

    return data
  } catch (error) {
    await cleanupNotificationMedia(
      uploadedUrls
    )

    throw error
  }
}

export async function createAuthorStoryNotificationSafely(
  payload
) {
  try {
    return await createAuthorStoryNotification(
      payload
    )
  } catch (error) {
    console.error(
      'CREATE AUTHOR STORY NOTIFICATION ERROR:',
      error
    )

    return null
  }
}
