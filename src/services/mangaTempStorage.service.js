import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'

const TEMP_PREFIX = 'temp-processing/manga-v2/'

let r2Client = null

function getR2Client() {
  if (r2Client) return r2Client

  const accountId = process.env.R2_ACCOUNT_ID
  const accessKeyId = process.env.R2_ACCESS_KEY_ID
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY

  if (!accountId || !accessKeyId || !secretAccessKey) {
    const error = new Error(
      'Missing R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, or R2_SECRET_ACCESS_KEY'
    )
    error.code = 'R2_CONFIGURATION_ERROR'
    error.statusCode = 500
    throw error
  }

  r2Client = new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
  })

  return r2Client
}

function getR2BucketName() {
  const bucketName = String(process.env.R2_BUCKET_NAME || '').trim()

  if (!bucketName) {
    const error = new Error('Missing R2_BUCKET_NAME')
    error.code = 'R2_CONFIGURATION_ERROR'
    error.statusCode = 500
    throw error
  }

  return bucketName
}

function requireTempKey(value) {
  const key = String(value || '').trim()

  if (!key.startsWith(TEMP_PREFIX) || key.includes('..')) {
    const error = new Error('Invalid temporary manga storage key.')
    error.code = 'INVALID_MANGA_TEMP_KEY'
    error.statusCode = 400
    throw error
  }

  return key
}

function requirePositiveInteger(value, fieldName) {
  const number = Number(value)

  if (!Number.isSafeInteger(number) || number <= 0) {
    const error = new Error(`${fieldName} must be a positive integer.`)
    error.code = 'INVALID_MANGA_TEMP_STORAGE_INPUT'
    error.statusCode = 400
    throw error
  }

  return number
}

export async function uploadMangaTempStream({
  key,
  body,
  contentType,
  contentLength,
}) {
  const safeKey = requireTempKey(key)
  const safeLength = requirePositiveInteger(
    contentLength,
    'contentLength'
  )

  await getR2Client().send(
    new PutObjectCommand({
      Bucket: getR2BucketName(),
      Key: safeKey,
      Body: body,
      ContentLength: safeLength,
      ContentType:
        String(contentType || '').trim() ||
        'application/octet-stream',
      CacheControl: 'no-store, max-age=0',
      Metadata: {
        temporary: 'true',
        purpose: 'manga-v2-processing',
      },
    })
  )

  return safeKey
}

export async function downloadMangaTempBuffer(
  key,
  maxBytes
) {
  const safeKey = requireTempKey(key)
  const safeMaxBytes = requirePositiveInteger(
    maxBytes,
    'maxBytes'
  )

  const response = await getR2Client().send(
    new GetObjectCommand({
      Bucket: getR2BucketName(),
      Key: safeKey,
    })
  )

  const declaredLength = Number(response.ContentLength || 0)

  if (declaredLength > safeMaxBytes) {
    const error = new Error('Manga page must be 5 MB or smaller.')
    error.code = 'MANGA_PAGE_TOO_LARGE'
    error.statusCode = 413
    error.stage = 'receive'
    throw error
  }

  if (!response.Body) {
    const error = new Error('Temporary manga image is missing.')
    error.code = 'MANGA_TEMP_OBJECT_EMPTY'
    error.statusCode = 500
    error.stage = 'storage'
    throw error
  }

  const chunks = []
  let totalBytes = 0

  for await (const chunk of response.Body) {
    const buffer = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk)

    totalBytes += buffer.length

    if (totalBytes > safeMaxBytes) {
      response.Body.destroy?.()

      const error = new Error('Manga page must be 5 MB or smaller.')
      error.code = 'MANGA_PAGE_TOO_LARGE'
      error.statusCode = 413
      error.stage = 'receive'
      throw error
    }

    chunks.push(buffer)
  }

  if (totalBytes === 0) {
    const error = new Error('Temporary manga image is empty.')
    error.code = 'MANGA_TEMP_OBJECT_EMPTY'
    error.statusCode = 500
    error.stage = 'storage'
    throw error
  }

  return Buffer.concat(chunks, totalBytes)
}

export async function deleteMangaTempObject(key) {
  const safeKey = requireTempKey(key)

  await getR2Client().send(
    new DeleteObjectCommand({
      Bucket: getR2BucketName(),
      Key: safeKey,
    })
  )

  return true
}
