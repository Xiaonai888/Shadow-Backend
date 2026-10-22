import { lstat, realpath } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createReadStream } from 'node:fs'
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'

let privateR2Client = null

function getPrivateR2Client() {
  if (privateR2Client) {
    return privateR2Client
  }

  const accountId = String(
    process.env.R2_ACCOUNT_ID || ''
  ).trim()
  const accessKeyId = String(
    process.env.R2_PRIVATE_ACCESS_KEY_ID || ''
  ).trim()
  const secretAccessKey = String(
    process.env.R2_PRIVATE_SECRET_ACCESS_KEY || ''
  ).trim()

  if (
    !accountId ||
    !accessKeyId ||
    !secretAccessKey
  ) {
    throw new Error(
      'Missing R2_ACCOUNT_ID, R2_PRIVATE_ACCESS_KEY_ID, or R2_PRIVATE_SECRET_ACCESS_KEY'
    )
  }

  privateR2Client = new S3Client({
    region: 'auto',
    endpoint:
      `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
  })

  return privateR2Client
}

function getPrivateBucketName() {
  const bucketName = String(
    process.env.R2_PRIVATE_BUCKET_NAME || ''
  ).trim()

  if (!bucketName) {
    throw new Error(
      'Missing R2_PRIVATE_BUCKET_NAME'
    )
  }

  return bucketName
}

function safeFileName(value) {
  const original = String(
    value || 'screenshot'
  ).trim()
  const withoutPath =
    original
      .split(/[\\/]/)
      .pop() || 'screenshot'

  return (
    withoutPath
      .normalize('NFKD')
      .replace(
        /[^a-zA-Z0-9._-]+/g,
        '-'
      )
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(-120) ||
    'screenshot'
  )
}

function createStorageKey(
  userId,
  requestId,
  originalName
) {
  const readerId = String(
    userId || ''
  ).trim()
  const ticketId = String(
    requestId || ''
  ).trim()

  if (
    !readerId ||
    !ticketId
  ) {
    throw new Error(
      'User ID and request ID are required'
    )
  }

  const random = Math.random()
    .toString(36)
    .slice(2, 12)

  return (
    `support-screenshots/${readerId}/${ticketId}/` +
    `${Date.now()}-${random}-${safeFileName(originalName)}`
  )
}

async function getVerifiedScreenshotFile(file) {
  const invalid = () => {
    const error = new Error('Invalid screenshot temporary upload file')
    error.statusCode = 400
    error.code = 'INVALID_SCREENSHOT_UPLOAD_PATH'
    throw error
  }

  const filename = String(file?.filename || '')
  if (!/^[a-f0-9]{32}$/i.test(filename)) invalid()

  const root = path.resolve(os.tmpdir())
  const requested = path.resolve(String(file?.path || ''))
  const candidate = path.join(root, filename)
  const actualRoot = await realpath(root)
  const actualPath = path.join(actualRoot, filename)

  if (requested !== candidate && requested !== actualPath) invalid()

  const details = await lstat(candidate)
  if (!details.isFile() || details.size < 1 || details.size > 2 * 1024 * 1024) {
    invalid()
  }

  if (await realpath(candidate) !== actualPath) invalid()

  return { path: candidate, size: details.size }
}

export async function uploadSupportScreenshotToR2({
  userId,
  requestId,
  file,
}) {
  if (!file?.path) {
    throw new Error('Screenshot file is required')
  }

  const verified = await getVerifiedScreenshotFile(file)
  const storageKey = createStorageKey(
    userId,
    requestId,
    file.originalname
  )

  await getPrivateR2Client().send(
    new PutObjectCommand({
      Bucket: getPrivateBucketName(),
      Key: storageKey,
      Body: createReadStream(verified.path),
      ContentLength: verified.size,
      ContentType: file.mimetype || 'application/octet-stream',
      CacheControl: 'private, no-store, no-cache, must-revalidate',
      Metadata: {
        user_id: String(userId),
        request_id: String(requestId),
        original_file_name: safeFileName(file.originalname),
      },
    })
  )

  return {
    storageKey,
    fileName: safeFileName(file.originalname),
    mimeType: file.mimetype || 'application/octet-stream',
    fileSize: verified.size,
  }
}


export async function getSupportScreenshotFromR2(
  storageKey
) {
  const key = String(
    storageKey || ''
  ).trim()

  if (!key) return null

  return getPrivateR2Client().send(
    new GetObjectCommand({
      Bucket:
        getPrivateBucketName(),
      Key: key,
    })
  )
}

export async function deleteSupportScreenshotFromR2(
  storageKey
) {
  const key = String(
    storageKey || ''
  ).trim()

  if (!key) return

  await getPrivateR2Client().send(
    new DeleteObjectCommand({
      Bucket:
        getPrivateBucketName(),
      Key: key,
    })
  )
}
