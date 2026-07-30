import { randomUUID } from 'node:crypto'
import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import sharp from 'sharp'

const MAX_IMAGE_BYTES = 300 * 1024
const RESIZE_WIDTHS = [768, 640, 512, 384, 320, 256]
const QUALITY_LEVELS = [82, 76, 70, 64, 58, 52, 46, 40]

let client = null

function env(...names) {
  for (const name of names) {
    const value = String(process.env[name] || '').trim()
    if (value) return value
  }
  return ''
}

function configuration() {
  const accountId = env('R2_ACCOUNT_ID')
  const endpoint = env('CLOUDFLARE_R2_ENDPOINT') ||
    (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : '')
  const accessKeyId = env('CLOUDFLARE_R2_ACCESS_KEY_ID', 'R2_ACCESS_KEY_ID')
  const secretAccessKey = env('CLOUDFLARE_R2_SECRET_ACCESS_KEY', 'R2_SECRET_ACCESS_KEY')
  const bucket = env('CLOUDFLARE_R2_BUCKET', 'R2_BUCKET_NAME')
  const publicUrl = env('CLOUDFLARE_R2_PUBLIC_URL', 'R2_PUBLIC_URL').replace(/\/+$/, '')

  if (!endpoint || !accessKeyId || !secretAccessKey || !bucket || !publicUrl) {
    throw new Error('Cloudflare R2 is not configured')
  }

  return { endpoint, accessKeyId, secretAccessKey, bucket, publicUrl }
}

function r2() {
  if (client) return client
  const config = configuration()
  client = new S3Client({
    region: 'auto',
    endpoint: config.endpoint,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  })
  return client
}

function safeSegment(value, fallback = 'media') {
  const output = String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120)
  return output || fallback
}

function uniqueKeys(values) {
  return [...new Set((values || []).map((value) => String(value || '').trim()).filter(Boolean))]
}

async function createOptimizedWebP(file) {
  const metadata = await sharp(file.buffer, { failOn: 'none' }).metadata()
  const width = Number(metadata.width || 0)
  const height = Number(metadata.height || 0)

  if (
    file.mimetype === 'image/webp' &&
    file.buffer.length <= MAX_IMAGE_BYTES &&
    width > 0 &&
    height > 0 &&
    width <= 768 &&
    height <= 768
  ) {
    return file.buffer
  }

  let smallestBuffer = null

  for (const maxWidth of RESIZE_WIDTHS) {
    for (const quality of QUALITY_LEVELS) {
      const buffer = await sharp(file.buffer, { failOn: 'none' })
        .rotate()
        .resize({
          width: maxWidth,
          height: maxWidth,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .webp({
          quality,
          effort: 4,
          smartSubsample: true,
        })
        .toBuffer()

      if (!smallestBuffer || buffer.length < smallestBuffer.length) {
        smallestBuffer = buffer
      }

      if (buffer.length <= MAX_IMAGE_BYTES) {
        return buffer
      }
    }
  }

  return smallestBuffer
}

export async function uploadMediaLibraryObject({ file, prefix = 'media-library/images' }) {
  if (!file?.buffer?.length) throw new Error('Image file is required')
  if (!String(file.mimetype || '').startsWith('image/')) throw new Error('Only image files are allowed')

  const config = configuration()
  const optimizedBuffer = await createOptimizedWebP(file)
  const key = `${String(prefix || 'media-library/images').replace(/^\/+|\/+$/g, '')}/${Date.now()}-${randomUUID()}.webp`

  await r2().send(new PutObjectCommand({
    Bucket: config.bucket,
    Key: key,
    Body: optimizedBuffer,
    ContentType: 'image/webp',
    CacheControl: 'public, max-age=31536000, immutable',
  }))

  const head = await r2().send(new HeadObjectCommand({
    Bucket: config.bucket,
    Key: key,
  }))

  const uploadedSize = Number(head.ContentLength || 0)

  if (uploadedSize !== optimizedBuffer.length) {
    await deleteMediaLibraryObject(key).catch(() => {})
    throw new Error('Cloudflare R2 upload verification failed')
  }

  return {
    storage_key: key,
    image_url: `${config.publicUrl}/${key}`,
    file_size: uploadedSize,
    source_file_size: Number(file.size || file.buffer.length || 0),
    mime_type: 'image/webp',
  }
}

export async function deleteMediaLibraryObject(storageKey) {
  const key = String(storageKey || '').trim()
  if (!key) return false
  const config = configuration()
  await r2().send(new DeleteObjectCommand({
    Bucket: config.bucket,
    Key: key,
  }))
  return true
}

export async function deleteMediaLibraryObjects(storageKeys) {
  const keys = uniqueKeys(storageKeys)
  if (!keys.length) return { deleted: 0 }
  const config = configuration()
  let deleted = 0

  for (let index = 0; index < keys.length; index += 1000) {
    const batch = keys.slice(index, index + 1000)
    await r2().send(new DeleteObjectsCommand({
      Bucket: config.bucket,
      Delete: {
        Quiet: true,
        Objects: batch.map((Key) => ({ Key })),
      },
    }))
    deleted += batch.length
  }

  return { deleted }
}

export function mediaLibraryFolderPrefix(folderId) {
  return `media-library/folders/${safeSegment(folderId, 'folder')}`
}
