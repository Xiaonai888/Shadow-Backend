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

export async function uploadSupportScreenshotToR2({
  userId,
  requestId,
  file,
}) {
  if (!file?.path) {
    throw new Error(
      'Screenshot file is required'
    )
  }

  const storageKey =
    createStorageKey(
      userId,
      requestId,
      file.originalname
    )

  await getPrivateR2Client().send(
    new PutObjectCommand({
      Bucket:
        getPrivateBucketName(),
      Key: storageKey,
      Body: createReadStream(
        file.path
      ),
      ContentLength:
        Number(file.size || 0) ||
        undefined,
      ContentType:
        file.mimetype ||
        'application/octet-stream',
      CacheControl:
        'private, no-store, no-cache, must-revalidate',
      Metadata: {
        user_id:
          String(userId),
        request_id:
          String(requestId),
        original_file_name:
          safeFileName(
            file.originalname
          ),
      },
    })
  )

  return {
    storageKey,
    fileName:
      safeFileName(
        file.originalname
      ),
    mimeType:
      file.mimetype ||
      'application/octet-stream',
    fileSize:
      Number(file.size || 0),
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
