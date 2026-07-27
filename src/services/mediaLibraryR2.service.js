import { randomUUID } from 'node:crypto'
import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'

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

function extension(file) {
  const original = String(file?.originalname || '')
  const namePart = original.includes('.') ? original.split('.').pop() : ''
  const mimePart = String(file?.mimetype || '').split('/')[1] || ''
  const output = String(namePart || mimePart || 'jpg')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
  return output === 'jpeg' ? 'jpg' : output || 'jpg'
}

function uniqueKeys(values) {
  return [...new Set((values || []).map((value) => String(value || '').trim()).filter(Boolean))]
}

export async function uploadMediaLibraryObject({ file, prefix = 'media-library/images' }) {
  if (!file?.buffer?.length) throw new Error('Image file is required')
  if (!String(file.mimetype || '').startsWith('image/')) throw new Error('Only image files are allowed')

  const config = configuration()
  const key = `${String(prefix || 'media-library/images').replace(/^\/+|\/+$/g, '')}/${Date.now()}-${randomUUID()}.${extension(file)}`

  await r2().send(new PutObjectCommand({
    Bucket: config.bucket,
    Key: key,
    Body: file.buffer,
    ContentType: file.mimetype,
    CacheControl: 'public, max-age=31536000, immutable',
  }))

  const head = await r2().send(new HeadObjectCommand({
    Bucket: config.bucket,
    Key: key,
  }))

  const uploadedSize = Number(head.ContentLength || 0)
  const sourceSize = Number(file.size || file.buffer.length || 0)

  if (uploadedSize !== sourceSize) {
    await deleteMediaLibraryObject(key).catch(() => {})
    throw new Error('Cloudflare R2 upload verification failed')
  }

  return {
    storage_key: key,
    image_url: `${config.publicUrl}/${key}`,
    file_size: uploadedSize,
    mime_type: head.ContentType || file.mimetype,
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
