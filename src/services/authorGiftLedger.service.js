import { supabase } from '../config/supabase.js'
import {
  deleteR2ObjectByUrl,
  uploadFileToR2,
} from './r2Storage.service.js'
import {
  assertR2MediaReference,
  isInlineMediaValue,
  isR2PublicUrl,
  isSupabaseStorageUrl,
} from './mediaStoragePolicy.service.js'

const GIFT_MEDIA_MAX_BYTES = 5 * 1024 * 1024

function numberValue(value) {
  const number = Number(value || 0)
  return Number.isFinite(number) ? number : 0
}

function detectImageType(buffer) {
  if (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
    )
  ) {
    return { mimetype: 'image/png', extension: 'png' }
  }

  if (
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  ) {
    return { mimetype: 'image/jpeg', extension: 'jpg' }
  }

  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return { mimetype: 'image/webp', extension: 'webp' }
  }

  if (
    buffer.length >= 6 &&
    ['GIF87a', 'GIF89a'].includes(
      buffer.subarray(0, 6).toString('ascii')
    )
  ) {
    return { mimetype: 'image/gif', extension: 'gif' }
  }

  return null
}

function decodeInlineImage(value) {
  const input = String(value || '').trim()
  const match = input.match(
    /^data:image\/(png|jpe?g|webp|gif);base64,([a-z0-9+/=\s]+)$/i
  )

  if (!match) return null

  const encoded = match[2].replace(/\s+/g, '')

  if (encoded.length > 7 * 1024 * 1024) {
    return null
  }

  const buffer = Buffer.from(encoded, 'base64')
  const type = detectImageType(buffer)

  if (
    !type ||
    !buffer.length ||
    buffer.length > GIFT_MEDIA_MAX_BYTES
  ) {
    return null
  }

  return { buffer, ...type }
}

async function readSupabaseImage(value) {
  let sourceUrl

  try {
    sourceUrl = new URL(value)
  } catch {
    return null
  }

  const configuredUrl = String(
    process.env.SUPABASE_URL || ''
  ).trim()

  if (!configuredUrl) return null

  let allowedOrigin

  try {
    allowedOrigin = new URL(configuredUrl).origin
  } catch {
    return null
  }

  if (sourceUrl.origin !== allowedOrigin) {
    return null
  }

  try {
    const response = await fetch(sourceUrl)

    if (!response.ok) return null

    const length = Number(
      response.headers.get('content-length') || 0
    )

    if (length > GIFT_MEDIA_MAX_BYTES) {
      return null
    }

    const buffer = Buffer.from(
      await response.arrayBuffer()
    )
    const type = detectImageType(buffer)

    if (
      !type ||
      !buffer.length ||
      buffer.length > GIFT_MEDIA_MAX_BYTES
    ) {
      return null
    }

    return { buffer, ...type }
  } catch (error) {
    console.warn(
      'READ AUTHOR GIFT MEDIA WARNING:',
      error.message
    )
    return null
  }
}

async function normalizeGiftMedia(
  value,
  {
    authorId,
    kind,
    cache,
    uploadedUrls,
  }
) {
  const input = String(value || '').trim()

  if (!input) return ''
  if (cache.has(input)) return cache.get(input)

  if (isR2PublicUrl(input)) {
    const url = assertR2MediaReference(input, {
      field: `author_gift_ledger.${kind}`,
      allowEmpty: false,
    })

    cache.set(input, url)
    return url
  }

  let image = null

  if (isSupabaseStorageUrl(input)) {
    image = await readSupabaseImage(input)
  } else if (isInlineMediaValue(input)) {
    image = decodeInlineImage(input)
  } else {
    return input
  }

  if (!image) {
    cache.set(input, '')
    return ''
  }

  try {
    const url = await uploadFileToR2(
      {
        buffer: image.buffer,
        originalname: `${kind}.${image.extension}`,
        mimetype: image.mimetype,
      },
      `author-gift-ledger/${authorId}`
    )

    const safeUrl = assertR2MediaReference(url, {
      field: `author_gift_ledger.${kind}`,
      allowEmpty: false,
    })

    cache.set(input, safeUrl)
    uploadedUrls.add(safeUrl)

    return safeUrl
  } catch (error) {
    console.warn(
      'UPLOAD AUTHOR GIFT MEDIA WARNING:',
      error.message
    )

    cache.set(input, '')
    return ''
  }
}

async function cleanupGiftMedia(uploadedUrls) {
  for (const url of uploadedUrls) {
    try {
      await deleteR2ObjectByUrl(url)
    } catch (error) {
      console.warn(
        'AUTHOR GIFT MEDIA CLEANUP WARNING:',
        error.message
      )
    }
  }
}

export async function recordAuthorGift({
  sourceKey,
  authorId,
  authorUserId = null,
  readerId = null,
  readerName = 'Reader',
  readerUsername = '',
  readerAvatarUrl = '',
  storyId = null,
  storyTitle = 'Story',
  giftId = null,
  giftKey = '',
  giftName = 'Gift',
  giftImagePath = '',
  quantity = 1,
  currency = '',
  price = 0,
  supportPoints = 0,
  createdAt = null,
}) {
  if (!sourceKey || !authorId) return null

  const uploadedUrls = new Set()

  try {
    const context = {
      authorId,
      cache: new Map(),
      uploadedUrls,
    }

    const [
      safeReaderAvatarUrl,
      safeGiftImagePath,
    ] = await Promise.all([
      normalizeGiftMedia(readerAvatarUrl, {
        ...context,
        kind: 'reader_avatar_url',
      }),
      normalizeGiftMedia(giftImagePath, {
        ...context,
        kind: 'gift_image_path',
      }),
    ])

    const row = {
      source_key: String(sourceKey),
      author_id: authorId,
      author_user_id: authorUserId,
      reader_id: readerId,
      reader_name: String(readerName || 'Reader'),
      reader_username: String(readerUsername || ''),
      reader_avatar_url: safeReaderAvatarUrl,
      story_id: storyId,
      story_title: String(storyTitle || 'Story'),
      gift_id: giftId ? String(giftId) : null,
      gift_key: String(giftKey || ''),
      gift_name: String(giftName || 'Gift'),
      gift_image_path: safeGiftImagePath,
      quantity: Math.max(
        1,
        Math.floor(numberValue(quantity))
      ),
      currency: String(currency || ''),
      price: numberValue(price),
      support_points: numberValue(supportPoints),
    }

    if (createdAt) {
      row.created_at = createdAt
    }

    const { data, error } = await supabase
      .from('author_gift_ledger')
      .upsert(row, {
        onConflict: 'source_key',
        ignoreDuplicates: true,
      })
      .select()
      .maybeSingle()

    if (error) throw error

    if (!data) {
      await cleanupGiftMedia(uploadedUrls)
      return null
    }

    uploadedUrls.clear()
    return data
  } catch (error) {
    await cleanupGiftMedia(uploadedUrls)
    throw error
  }
}

export async function recordAuthorGiftSafely(payload) {
  try {
    return await recordAuthorGift(payload)
  } catch (error) {
    console.error('RECORD AUTHOR GIFT ERROR:', error)
    return null
  }
}
