import {
  CopyObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { createPresignedPutUrl } from './storyVideoDirectUpload.service.js'
import { mangaDevicePartsError, MANGA_DEVICE_PARTS_LIMITS } from './mangaDevicePartsPolicy.service.js'

let client = null

function config() {
  const account = String(process.env.R2_ACCOUNT_ID || '').trim()
  const accessKeyId = String(process.env.R2_ACCESS_KEY_ID || '').trim()
  const secretAccessKey = String(process.env.R2_SECRET_ACCESS_KEY || '').trim()
  const bucket = String(process.env.R2_BUCKET_NAME || '').trim()
  const publicUrl = String(process.env.R2_PUBLIC_URL || '').trim().replace(/\/+$/, '')
  if (!account || !accessKeyId || !secretAccessKey || !bucket || !/^https:\/\//i.test(publicUrl)) {
    throw mangaDevicePartsError(503, 'MANGA_DEVICE_R2_UNAVAILABLE', 'Manga R2 storage is not configured', 'storage')
  }
  return { account, accessKeyId, secretAccessKey, bucket, publicUrl }
}

function r2() {
  if (!client) {
    const cfg = config()
    client = new S3Client({
      region: 'auto',
      endpoint: `https://${cfg.account}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    })
  }
  return client
}

export function mangaDevicePartKeys(owner, sessionId, partIndex) {
  const suffix = `part-${String(partIndex).padStart(3, '0')}.webp`
  return {
    temporary: `temp-processing/manga-device-parts/${owner}/${sessionId}/${suffix}`,
    final: `episode-content/${owner}/manga-v2/device/${sessionId}/${suffix}`,
  }
}

export function createMangaDevicePartSignedUrl(key, size) {
  config()
  return createPresignedPutUrl(key, 'image/webp', MANGA_DEVICE_PARTS_LIMITS.signedUrlSeconds, size)
}

function webpDimensions(bytes, fullBytes) {
  if (
    bytes.length < 30 ||
    bytes.toString('ascii', 0, 4) !== 'RIFF' ||
    bytes.toString('ascii', 8, 12) !== 'WEBP' ||
    bytes.readUInt32LE(4) + 8 !== fullBytes
  ) return null

  const chunk = bytes.toString('ascii', 12, 16)
  let width
  let height
  if (chunk === 'VP8X') {
    if (bytes.readUInt32LE(16) < 10 || (bytes[20] & 0x02) !== 0) return null
    width = 1 + bytes.readUIntLE(24, 3)
    height = 1 + bytes.readUIntLE(27, 3)
  } else if (chunk === 'VP8L') {
    if (bytes[20] !== 0x2f) return null
    width = 1 + (bytes[21] | ((bytes[22] & 0x3f) << 8))
    height = 1 + ((bytes[22] >> 6) | (bytes[23] << 2) | ((bytes[24] & 0x0f) << 10))
  } else if (chunk === 'VP8 ') {
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return null
    width = bytes.readUInt16LE(26) & 0x3fff
    height = bytes.readUInt16LE(28) & 0x3fff
  } else {
    return null
  }
  return width > 0 && height > 0 ? { width, height } : null
}

async function inspectObject(key, part) {
  const cfg = config()
  let head
  try {
    head = await r2().send(new HeadObjectCommand({ Bucket: cfg.bucket, Key: key }))
  } catch (error) {
    if (error?.name === 'NotFound' || error?.$metadata?.httpStatusCode === 404) {
      throw mangaDevicePartsError(404, 'MANGA_DEVICE_PART_MISSING', 'Manga part is missing from R2', 'verify')
    }
    throw error
  }

  const size = Number(head.ContentLength || 0)
  const mime = String(head.ContentType || '').toLowerCase().split(';')[0].trim()
  if (size !== part.size || mime !== 'image/webp') {
    throw mangaDevicePartsError(422, 'MANGA_DEVICE_PART_MISMATCH', 'Manga part size or MIME type does not match', 'verify')
  }

  const response = await r2().send(new GetObjectCommand({
    Bucket: cfg.bucket,
    Key: key,
    Range: 'bytes=0-63',
  }))
  const stream = response.Body
  if (!stream) {
    throw mangaDevicePartsError(422, 'MANGA_DEVICE_PART_EMPTY', 'Manga part has no data', 'verify')
  }

  const chunks = []
  let received = 0
  try {
    for await (const chunk of stream) {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      received += value.length
      if (received > 64) {
        throw mangaDevicePartsError(422, 'MANGA_DEVICE_RANGE_TOO_LARGE', 'R2 returned more image data than requested', 'verify')
      }
      chunks.push(value)
    }
  } finally {
    stream.destroy?.()
  }
  const bytes = Buffer.concat(chunks, received)
  const dimensions = webpDimensions(bytes, size)
  if (!dimensions || dimensions.width !== part.width || dimensions.height !== part.height) {
    throw mangaDevicePartsError(422, 'MANGA_DEVICE_PART_IMAGE_INVALID', 'Manga WebP header or dimensions are invalid', 'verify')
  }
  if (!head.ETag) {
    throw mangaDevicePartsError(503, 'MANGA_DEVICE_ETAG_MISSING', 'R2 did not return an object version marker', 'verify')
  }
  return { etag: head.ETag }
}

export async function verifyMangaDevicePart({ owner, sessionId, part }) {
  const keys = mangaDevicePartKeys(owner, sessionId, part.partIndex)
  const { etag } = await inspectObject(keys.temporary, part)
  return { ...keys, etag }
}

export async function copyVerifiedMangaDevicePart({ owner, sessionId, part, checked }) {
  const cfg = config()
  const { final, temporary } = mangaDevicePartKeys(owner, sessionId, part.partIndex)
  await r2().send(new CopyObjectCommand({
    Bucket: cfg.bucket,
    Key: final,
    CopySource: `${encodeURIComponent(cfg.bucket)}/${temporary.split('/').map(encodeURIComponent).join('/')}`,
    CopySourceIfMatch: checked.etag,
    MetadataDirective: 'REPLACE',
    ContentType: 'image/webp',
    CacheControl: 'public, max-age=31536000, immutable',
  }))
  await inspectObject(final, part)
  return {
    part_index: part.partIndex,
    image_url: `${cfg.publicUrl}/${final}`,
    storage_path: final,
    width: part.width,
    height: part.height,
    file_size: part.size,
    mime_type: 'image/webp',
    quality: part.quality,
  }
}
