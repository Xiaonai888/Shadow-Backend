import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3'

const VIDEO_MIME_TYPES = new Set(['video/mp4', 'video/quicktime'])
const EXTENSION_BY_MIME = {
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
}
const MAX_VIDEO_BYTES = 30 * 1024 * 1024
const MIN_VIDEO_BYTES = 1024
const MAX_VIDEO_DURATION_SECONDS = 60
const PRESIGNED_URL_TTL_SECONDS = 5 * 60
const FINALIZE_TOKEN_TTL_SECONDS = 12 * 60
const ABANDONED_UPLOAD_AGE_MS = 30 * 60 * 1000
const MAX_BOX_SCAN_COUNT = 128
const INIT_WINDOW_MS = 10 * 60 * 1000
const INIT_LIMIT_PER_WINDOW = 8

let r2Client = null
const initWindows = new Map()

function getR2Config() {
  const accountId = String(process.env.R2_ACCOUNT_ID || '').trim()
  const accessKeyId = String(process.env.R2_ACCESS_KEY_ID || '').trim()
  const secretAccessKey = String(process.env.R2_SECRET_ACCESS_KEY || '').trim()
  const bucket = String(process.env.R2_BUCKET_NAME || '').trim()
  const publicUrl = String(process.env.R2_PUBLIC_URL || '').trim().replace(/\/+$/, '')

  if (!accountId || !accessKeyId || !secretAccessKey || !bucket || !publicUrl) {
    const error = new Error('Cloudflare R2 configuration is missing')
    error.statusCode = 500
    error.code = 'R2_ENV_MISSING'
    throw error
  }

  return {
    accountId,
    accessKeyId,
    secretAccessKey,
    bucket,
    publicUrl,
    host: `${accountId}.r2.cloudflarestorage.com`,
  }
}

function getR2Client() {
  if (r2Client) return r2Client

  const { accountId, accessKeyId, secretAccessKey } = getR2Config()

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

function cleanId(value) {
  return String(value || '').trim().replace(/[^a-zA-Z0-9_-]/g, '')
}

function normalizeMode(value) {
  const mode = String(value || '').trim().toLowerCase()
  if (mode !== 'reader' && mode !== 'author') {
    const error = new Error('Invalid story upload mode')
    error.statusCode = 400
    error.code = 'STORY_VIDEO_MODE_INVALID'
    throw error
  }
  return mode
}

function normalizeMimeType(value) {
  const mimeType = String(value || '').trim().toLowerCase()
  if (!VIDEO_MIME_TYPES.has(mimeType)) {
    const error = new Error('Only MP4 or MOV videos are allowed')
    error.statusCode = 400
    error.code = 'STORY_VIDEO_TYPE_INVALID'
    throw error
  }
  return mimeType
}

function normalizeFileSize(value) {
  const fileSize = Number(value)
  if (!Number.isFinite(fileSize) || fileSize < MIN_VIDEO_BYTES) {
    const error = new Error('Choose a valid video file')
    error.statusCode = 400
    error.code = 'STORY_VIDEO_SIZE_INVALID'
    throw error
  }
  if (fileSize > MAX_VIDEO_BYTES) {
    const error = new Error('Video must be 30 MB or smaller')
    error.statusCode = 413
    error.code = 'STORY_MEDIA_TOO_LARGE'
    throw error
  }
  return Math.floor(fileSize)
}

function encodeRfc3986(value) {
  return encodeURIComponent(String(value)).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  )
}

function encodePath(value) {
  return String(value)
    .split('/')
    .map((part) => encodeRfc3986(part))
    .join('/')
}

function hmac(key, value, encoding) {
  return createHmac('sha256', key).update(value).digest(encoding)
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function getAmzDate(date = new Date()) {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, '')
}

function createPresignedPutUrl(objectKey, mimeType, expiresInSeconds = PRESIGNED_URL_TTL_SECONDS) {
  const config = getR2Config()
  const amzDate = getAmzDate()
  const dateStamp = amzDate.slice(0, 8)
  const credentialScope = `${dateStamp}/auto/s3/aws4_request`
  const canonicalUri = `/${encodePath(config.bucket)}/${encodePath(objectKey)}`
  const query = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${config.accessKeyId}/${credentialScope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(expiresInSeconds),
    'X-Amz-SignedHeaders': 'content-type;host',
  }
  const canonicalQuery = Object.entries(query)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${encodeRfc3986(key)}=${encodeRfc3986(value)}`)
    .join('&')
  const canonicalHeaders = `content-type:${mimeType}\nhost:${config.host}\n`
  const canonicalRequest = [
    'PUT',
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    'content-type;host',
    'UNSIGNED-PAYLOAD',
  ].join('\n')
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256(canonicalRequest),
  ].join('\n')
  const dateKey = hmac(`AWS4${config.secretAccessKey}`, dateStamp)
  const regionKey = hmac(dateKey, 'auto')
  const serviceKey = hmac(regionKey, 's3')
  const signingKey = hmac(serviceKey, 'aws4_request')
  const signature = hmac(signingKey, stringToSign, 'hex')

  return `https://${config.host}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`
}

function getUploadTokenSecret() {
  const secret = String(process.env.JWT_SECRET || '').trim()
  if (!secret) {
    const error = new Error('Upload signing configuration is missing')
    error.statusCode = 500
    error.code = 'STORY_VIDEO_SIGNING_MISSING'
    throw error
  }
  return secret
}

function signUploadClaims(claims) {
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
  const signature = createHmac('sha256', getUploadTokenSecret())
    .update(payload)
    .digest('base64url')
  return `${payload}.${signature}`
}

function verifyUploadClaims(token, userId, mode) {
  const [payload, signature] = String(token || '').split('.')

  if (!payload || !signature) {
    const error = new Error('Video upload token is invalid')
    error.statusCode = 400
    error.code = 'STORY_VIDEO_TOKEN_INVALID'
    throw error
  }

  const expected = createHmac('sha256', getUploadTokenSecret())
    .update(payload)
    .digest('base64url')
  const actualBuffer = Buffer.from(signature)
  const expectedBuffer = Buffer.from(expected)

  if (
    actualBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(actualBuffer, expectedBuffer)
  ) {
    const error = new Error('Video upload token is invalid')
    error.statusCode = 400
    error.code = 'STORY_VIDEO_TOKEN_INVALID'
    throw error
  }

  let claims
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  } catch {
    const error = new Error('Video upload token is invalid')
    error.statusCode = 400
    error.code = 'STORY_VIDEO_TOKEN_INVALID'
    throw error
  }

  const normalizedMode = normalizeMode(mode)
  const normalizedUserId = cleanId(userId)
  const expiresAt = Number(claims?.exp || 0)

  if (
    claims?.v !== 1 ||
    cleanId(claims?.user_id) !== normalizedUserId ||
    claims?.mode !== normalizedMode ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= Date.now()
  ) {
    const error = new Error('Video upload token has expired or is not valid for this account')
    error.statusCode = 400
    error.code = 'STORY_VIDEO_TOKEN_INVALID'
    throw error
  }

  const expectedPrefix = `story-video-temp/${normalizedMode}/${normalizedUserId}/`
  const objectKey = String(claims?.key || '').trim().replace(/^\/+/, '')

  if (!objectKey.startsWith(expectedPrefix) || objectKey.includes('..')) {
    const error = new Error('Video upload object is invalid')
    error.statusCode = 400
    error.code = 'STORY_VIDEO_OBJECT_INVALID'
    throw error
  }

  return {
    objectKey,
    mimeType: normalizeMimeType(claims?.mime_type),
    fileSize: normalizeFileSize(claims?.file_size),
    extension: EXTENSION_BY_MIME[claims?.mime_type],
  }
}

function enforceInitRateLimit(userId, mode) {
  const key = `${mode}:${userId}`
  const now = Date.now()
  const existing = initWindows.get(key)

  if (!existing || now - existing.startedAt >= INIT_WINDOW_MS) {
    initWindows.set(key, { startedAt: now, count: 1 })
    return
  }

  if (existing.count >= INIT_LIMIT_PER_WINDOW) {
    const error = new Error('Too many video upload attempts. Please wait a few minutes and try again.')
    error.statusCode = 429
    error.code = 'STORY_VIDEO_UPLOAD_RATE_LIMITED'
    throw error
  }

  existing.count += 1
}

async function bodyToBuffer(body) {
  if (!body) return Buffer.alloc(0)
  if (typeof body.transformToByteArray === 'function') {
    return Buffer.from(await body.transformToByteArray())
  }

  const chunks = []
  for await (const chunk of body) {
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

async function readObjectRange(objectKey, start, length) {
  if (length <= 0) return Buffer.alloc(0)

  const { bucket } = getR2Config()
  const end = start + length - 1
  const response = await getR2Client().send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: objectKey,
      Range: `bytes=${start}-${end}`,
    })
  )

  return bodyToBuffer(response.Body)
}

async function readBoxHeader(objectKey, offset, end) {
  if (offset + 8 > end) return null

  const first = await readObjectRange(objectKey, offset, Math.min(16, end - offset))
  if (first.length < 8) return null

  let size = first.readUInt32BE(0)
  const type = first.toString('ascii', 4, 8)
  let headerSize = 8

  if (size === 1) {
    if (first.length < 16) return null
    const largeSize = first.readBigUInt64BE(8)
    if (largeSize > BigInt(Number.MAX_SAFE_INTEGER)) return null
    size = Number(largeSize)
    headerSize = 16
  } else if (size === 0) {
    size = end - offset
  }

  if (size < headerSize || offset + size > end) return null

  return {
    type,
    start: offset,
    end: offset + size,
    payloadStart: offset + headerSize,
  }
}

async function findDirectChildBox(objectKey, start, end, wantedType) {
  let offset = start
  let scanned = 0

  while (offset + 8 <= end && scanned < MAX_BOX_SCAN_COUNT) {
    const box = await readBoxHeader(objectKey, offset, end)
    if (!box) return null
    if (box.type === wantedType) return box
    offset = box.end
    scanned += 1
  }

  return null
}

async function readVideoDurationSeconds(objectKey, fileSize) {
  const moov = await findDirectChildBox(objectKey, 0, fileSize, 'moov')
  if (!moov) return 0

  const mvhd = await findDirectChildBox(
    objectKey,
    moov.payloadStart,
    moov.end,
    'mvhd'
  )

  if (!mvhd || mvhd.payloadStart + 20 > mvhd.end) return 0

  const header = await readObjectRange(
    objectKey,
    mvhd.payloadStart,
    Math.min(32, mvhd.end - mvhd.payloadStart)
  )

  if (header.length < 20) return 0

  const version = header.readUInt8(0)

  if (version === 0) {
    const timescale = header.readUInt32BE(12)
    const duration = header.readUInt32BE(16)
    return timescale > 0 ? duration / timescale : 0
  }

  if (version === 1) {
    if (header.length < 32) return 0
    const timescale = header.readUInt32BE(20)
    const duration = header.readBigUInt64BE(24)
    if (!timescale || duration > BigInt(Number.MAX_SAFE_INTEGER)) return 0
    return Number(duration) / timescale
  }

  return 0
}

async function validateContainerSignature(objectKey, fileSize) {
  const header = await readObjectRange(objectKey, 0, Math.min(32, fileSize))

  if (header.length < 12 || header.toString('ascii', 4, 8) !== 'ftyp') {
    const error = new Error('Uploaded video is not a valid MP4 or MOV file')
    error.statusCode = 400
    error.code = 'STORY_VIDEO_SIGNATURE_INVALID'
    throw error
  }
}

async function deleteObject(objectKey) {
  const key = String(objectKey || '').trim().replace(/^\/+/, '')
  if (!key) return false

  const allowed =
    key.startsWith('story-video-temp/') ||
    key.startsWith('reader-stories/') ||
    key.startsWith('author-stories/')

  if (!allowed || key.includes('..')) return false

  const { bucket } = getR2Config()
  await getR2Client().send(
    new DeleteObjectCommand({
      Bucket: bucket,
      Key: key,
    })
  )
  return true
}

async function cleanupAbandonedUploads(userId, mode) {
  const normalizedUserId = cleanId(userId)
  const normalizedMode = normalizeMode(mode)
  if (!normalizedUserId) return

  const { bucket } = getR2Config()
  const prefix = `story-video-temp/${normalizedMode}/${normalizedUserId}/`
  const response = await getR2Client().send(
    new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      MaxKeys: 50,
    })
  )
  const cutoff = Date.now() - ABANDONED_UPLOAD_AGE_MS
  const stale = (response.Contents || []).filter((item) => {
    const updatedAt = item.LastModified ? new Date(item.LastModified).getTime() : 0
    return item.Key && updatedAt && updatedAt < cutoff
  })

  await Promise.allSettled(stale.map((item) => deleteObject(item.Key)))
}

export async function createStoryVideoUpload({
  userId,
  mode,
  mimeType,
  fileSize,
}) {
  const normalizedUserId = cleanId(userId)
  const normalizedMode = normalizeMode(mode)
  const normalizedMimeType = normalizeMimeType(mimeType)
  const normalizedFileSize = normalizeFileSize(fileSize)

  if (!normalizedUserId) {
    const error = new Error('Unauthorized')
    error.statusCode = 401
    error.code = 'UNAUTHORIZED'
    throw error
  }

  enforceInitRateLimit(normalizedUserId, normalizedMode)
  await cleanupAbandonedUploads(normalizedUserId, normalizedMode).catch(() => {})

  const extension = EXTENSION_BY_MIME[normalizedMimeType]
  const objectKey =
    `story-video-temp/${normalizedMode}/${normalizedUserId}/` +
    `${Date.now()}-${randomUUID()}.${extension}`
  const uploadUrl = createPresignedPutUrl(objectKey, normalizedMimeType)
  const uploadToken = signUploadClaims({
    v: 1,
    user_id: normalizedUserId,
    mode: normalizedMode,
    key: objectKey,
    mime_type: normalizedMimeType,
    file_size: normalizedFileSize,
    exp: Date.now() + FINALIZE_TOKEN_TTL_SECONDS * 1000,
  })

  return {
    upload_url: uploadUrl,
    upload_token: uploadToken,
    expires_in_seconds: PRESIGNED_URL_TTL_SECONDS,
    max_bytes: MAX_VIDEO_BYTES,
  }
}

export async function verifyStoryVideoUpload({
  uploadToken,
  userId,
  mode,
}) {
  const claims = verifyUploadClaims(uploadToken, userId, mode)
  const { bucket } = getR2Config()

  try {
    const head = await getR2Client().send(
      new HeadObjectCommand({
        Bucket: bucket,
        Key: claims.objectKey,
      })
    )

    const storedSize = Number(head.ContentLength || 0)
    const storedMimeType = normalizeMimeType(head.ContentType || claims.mimeType)

    if (storedSize !== claims.fileSize || storedSize > MAX_VIDEO_BYTES) {
      const error = new Error('Uploaded video size does not match the selected file')
      error.statusCode = 400
      error.code = 'STORY_VIDEO_SIZE_MISMATCH'
      throw error
    }

    if (storedMimeType !== claims.mimeType) {
      const error = new Error('Uploaded video type does not match the selected file')
      error.statusCode = 400
      error.code = 'STORY_VIDEO_TYPE_MISMATCH'
      throw error
    }

    await validateContainerSignature(claims.objectKey, storedSize)
    const durationSeconds = await readVideoDurationSeconds(claims.objectKey, storedSize)

    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      const error = new Error('Could not read video duration')
      error.statusCode = 400
      error.code = 'STORY_VIDEO_DURATION_UNREADABLE'
      throw error
    }

    if (durationSeconds > MAX_VIDEO_DURATION_SECONDS) {
      const error = new Error('Video must be 60 seconds or shorter')
      error.statusCode = 400
      error.code = 'STORY_VIDEO_TOO_LONG'
      throw error
    }

    return {
      tempKey: claims.objectKey,
      mimeType: storedMimeType,
      fileSize: storedSize,
      durationSeconds,
      extension: claims.extension,
    }
  } catch (error) {
    await deleteObject(claims.objectKey).catch(() => {})

    if (error?.name === 'NotFound' || error?.$metadata?.httpStatusCode === 404) {
      error.statusCode = 404
      error.code = 'STORY_VIDEO_UPLOAD_NOT_FOUND'
      error.message = 'Uploaded video could not be found'
    }

    throw error
  }
}

export async function commitStoryVideoUpload({
  verified,
  mode,
  ownerId,
}) {
  const normalizedMode = normalizeMode(mode)
  const normalizedOwnerId = cleanId(ownerId)

  if (!verified?.tempKey || !normalizedOwnerId) {
    const error = new Error('Video upload could not be finalized')
    error.statusCode = 400
    error.code = 'STORY_VIDEO_FINALIZE_INVALID'
    throw error
  }

  const { bucket, publicUrl } = getR2Config()
  const finalPrefix = normalizedMode === 'author' ? 'author-stories' : 'reader-stories'
  const finalKey =
    `${finalPrefix}/${normalizedOwnerId}/video/` +
    `${Date.now()}-${randomUUID()}.${verified.extension}`
  const copySource = `${encodeURIComponent(bucket)}/${verified.tempKey
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/')}`

  await getR2Client().send(
    new CopyObjectCommand({
      Bucket: bucket,
      Key: finalKey,
      CopySource: copySource,
      MetadataDirective: 'REPLACE',
      ContentType: verified.mimeType,
      CacheControl: 'public, max-age=86400',
    })
  )

  try {
    await deleteObject(verified.tempKey)
  } catch {}

  return {
    filePath: finalKey,
    publicUrl: `${publicUrl}/${finalKey}`,
    mimeType: verified.mimeType,
    fileSize: verified.fileSize,
    durationSeconds: verified.durationSeconds,
  }
}

export async function deleteStoryVideoObject(objectKey) {
  return deleteObject(objectKey)
}
