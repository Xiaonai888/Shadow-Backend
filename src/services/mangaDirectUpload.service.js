import { randomUUID } from 'node:crypto'
import jwt from 'jsonwebtoken'
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3'
import { supabase } from '../config/supabase.js'
import { createHeavyMediaJob } from './heavyMediaJob.service.js'
import { createPresignedPutUrl } from './storyVideoDirectUpload.service.js'

const MAX_BYTES = 5 * 1024 * 1024
const MIN_BYTES = 16
const SIGNED_URL_SECONDS = 300
const TOKEN_SECONDS = 900
const CLEANUP_AFTER_MS = 24 * 60 * 60 * 1000
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000
const INIT_WINDOW_MS = 10 * 60 * 1000
const INIT_WINDOW_LIMIT = 160
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])
const recentInits = new Map()
const recentCleanups = new Map()
let client = null

function fail(statusCode, code, message, stage = 'upload') {
  const error = new Error(message)
  error.statusCode = statusCode
  error.code = code
  error.stage = stage
  return error
}

function requireOwner(value) {
  const id = String(value || '').trim()
  if (!UUID.test(id)) throw fail(401, 'MANGA_DIRECT_UNAUTHORIZED', 'A valid account is required.', 'auth')
  return id
}

function assertEnabled() {
  if (String(process.env.MANGA_DIRECT_UPLOAD_ENABLED || '').toLowerCase() !== 'true') {
    throw fail(503, 'MANGA_DIRECT_DISABLED', 'Direct Manga upload is not enabled.', 'init')
  }
}

function bucketConfig() {
  const account = String(process.env.R2_ACCOUNT_ID || '').trim()
  const accessKeyId = String(process.env.R2_ACCESS_KEY_ID || '').trim()
  const secretAccessKey = String(process.env.R2_SECRET_ACCESS_KEY || '').trim()
  const bucket = String(process.env.R2_BUCKET_NAME || '').trim()
  if (!account || !accessKeyId || !secretAccessKey || !bucket || !process.env.JWT_SECRET) {
    throw fail(503, 'MANGA_DIRECT_UNAVAILABLE', 'Manga media storage is not configured.', 'storage')
  }
  return { account, accessKeyId, secretAccessKey, bucket }
}

function r2() {
  if (!client) {
    const cfg = bucketConfig()
    client = new S3Client({
      region: 'auto',
      endpoint: `https://${cfg.account}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    })
  }
  return client
}

function validateFile(size, mime) {
  const bytes = Number(size)
  const type = String(mime || '').trim().toLowerCase()
  if (!Number.isSafeInteger(bytes) || bytes < MIN_BYTES || bytes > MAX_BYTES) {
    throw fail(413, 'MANGA_DIRECT_SIZE_INVALID', 'Manga image must be at most 5 MB.', 'init')
  }
  if (!TYPES.has(type)) {
    throw fail(415, 'MANGA_DIRECT_TYPE_UNSUPPORTED', 'This image format requires the existing Manga V2 upload.', 'init')
  }
  return { size: bytes, mime: type }
}

function limitInits(owner) {
  if (recentInits.size > 5000) recentInits.clear()
  const now = Date.now()
  const last = recentInits.get(owner)
  if (!last || now - last.start >= INIT_WINDOW_MS) {
    recentInits.set(owner, { start: now, count: 1 })
    return
  }
  if (last.count >= INIT_WINDOW_LIMIT) {
    throw fail(429, 'MANGA_DIRECT_RATE_LIMIT', 'Too many Manga uploads. Please try again later.', 'init')
  }
  last.count += 1
}

function tokenClaims(token, owner) {
  let claims
  try {
    claims = jwt.verify(String(token || ''), process.env.JWT_SECRET, {
      audience: 'shadow-manga-direct',
      issuer: 'shadow-backend',
      algorithms: ['HS256'],
    })
  } catch {
    throw fail(401, 'MANGA_DIRECT_TOKEN_INVALID', 'Manga upload session expired or is invalid.', 'auth')
  }
  if (claims?.v !== 1 || claims?.purpose !== 'manga_page_v2' || claims?.owner !== owner || !UUID.test(String(claims.uploadId || ''))) {
    throw fail(403, 'MANGA_DIRECT_OWNER_MISMATCH', 'Manga upload belongs to a different account.', 'auth')
  }
  const file = validateFile(claims.size, claims.mime)
  const expectedKey = `temp-processing/manga-v2/${owner}/${claims.uploadId}/original`
  if (claims.key !== expectedKey) {
    throw fail(400, 'MANGA_DIRECT_KEY_INVALID', 'Manga upload session is invalid.', 'auth')
  }
  return { ...claims, ...file, key: expectedKey }
}

async function existingJob(owner, uploadId) {
  const { data, error } = await supabase
    .from('heavy_media_jobs')
    .select('id, job_type, temp_object_key')
    .eq('user_id', owner)
    .eq('idempotency_key', uploadId)
    .maybeSingle()
  if (error) throw fail(503, 'MANGA_DIRECT_JOB_LOOKUP_FAILED', 'Cannot check Manga processing status.', 'queue')
  return data || null
}

async function deleteTemporary(key) {
  await r2().send(new DeleteObjectCommand({ Bucket: bucketConfig().bucket, Key: key }))
}

async function checkImage(key, size, mime) {
  let head
  try {
    head = await r2().send(new HeadObjectCommand({ Bucket: bucketConfig().bucket, Key: key }))
  } catch (error) {
    if (error?.name === 'NotFound' || error?.$metadata?.httpStatusCode === 404) {
      throw fail(404, 'MANGA_DIRECT_NOT_FOUND', 'The uploaded Manga image was not found.', 'verify')
    }
    throw error
  }
  if (Number(head.ContentLength) !== size || String(head.ContentType || '').toLowerCase() !== mime) {
    await deleteTemporary(key).catch(() => {})
    throw fail(400, 'MANGA_DIRECT_FILE_MISMATCH', 'The uploaded Manga image does not match its declared size or type.', 'verify')
  }
  const response = await r2().send(new GetObjectCommand({
    Bucket: bucketConfig().bucket,
    Key: key,
    Range: 'bytes=0-31',
  }))
  const bytes = Buffer.from(await response.Body.transformToByteArray())
  const jpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  const png = bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
  const webp = bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'
  if (!({ 'image/jpeg': jpeg, 'image/png': png, 'image/webp': webp })[mime]) {
    await deleteTemporary(key).catch(() => {})
    throw fail(415, 'MANGA_DIRECT_IMAGE_INVALID', 'The uploaded file is not a valid Manga image.', 'verify')
  }
}

async function cleanupAbandoned(owner) {
  const now = Date.now()
  if (recentCleanups.size > 5000) recentCleanups.clear()
  if (now - (recentCleanups.get(owner) || 0) < CLEANUP_INTERVAL_MS) return
  recentCleanups.set(owner, now)
  const prefix = `temp-processing/manga-v2/${owner}/`
  const response = await r2().send(new ListObjectsV2Command({
    Bucket: bucketConfig().bucket,
    Prefix: prefix,
    MaxKeys: 200,
  }))
  const abandoned = (response.Contents || []).filter((item) => {
    if (!item.Key || !item.LastModified || now - new Date(item.LastModified).getTime() < CLEANUP_AFTER_MS) return false
    const relative = item.Key.slice(prefix.length)
    return /^([0-9a-f-]{36})\/original(?:-verified)?$/i.test(relative)
  }).slice(0, 40)
  if (!abandoned.length) return
  const ids = abandoned.map((item) => item.Key.slice(prefix.length).split('/')[0])
  const { data, error } = await supabase
    .from('heavy_media_jobs')
    .select('idempotency_key')
    .eq('user_id', owner)
    .in('idempotency_key', ids)
  if (error) throw error
  const protectedIds = new Set((data || []).map((job) => job.idempotency_key))
  await Promise.allSettled(abandoned.filter((item) => {
    const id = item.Key.slice(prefix.length).split('/')[0]
    return !protectedIds.has(id)
  }).map((item) => deleteTemporary(item.Key)))
}

export async function createMangaDirectUploadSession({ userId, fileSize, mimeType, fileName = '' }) {
  assertEnabled()
  const owner = requireOwner(userId)
  const file = validateFile(fileSize, mimeType)
  bucketConfig()
  limitInits(owner)
  const uploadId = randomUUID()
  const key = `temp-processing/manga-v2/${owner}/${uploadId}/original`
  const uploadUrl = createPresignedPutUrl(key, file.mime, SIGNED_URL_SECONDS, file.size)
  const uploadToken = jwt.sign({
    v: 1,
    purpose: 'manga_page_v2',
    owner,
    uploadId,
    key,
    size: file.size,
    mime: file.mime,
    name: String(fileName || 'manga-page').trim().slice(0, 240),
  }, process.env.JWT_SECRET, {
    expiresIn: TOKEN_SECONDS,
    audience: 'shadow-manga-direct',
    issuer: 'shadow-backend',
    algorithm: 'HS256',
  })
  void cleanupAbandoned(owner).catch(() => {})
  return {
    ok: true,
    upload_id: uploadId,
    upload_url: uploadUrl,
    upload_token: uploadToken,
    expires_in_seconds: SIGNED_URL_SECONDS,
    max_bytes: MAX_BYTES,
    required_headers: { 'Content-Type': file.mime },
  }
}

export async function finalizeMangaDirectUploadSession({ userId, uploadToken }) {
  assertEnabled()
  const owner = requireOwner(userId)
  const claims = tokenClaims(uploadToken, owner)
  const verifiedKey = `${claims.key}-verified`
  const previous = await existingJob(owner, claims.uploadId)
  if (previous) {
    if (previous.job_type !== 'manga_page_v2' || previous.temp_object_key !== verifiedKey) {
      throw fail(409, 'MANGA_DIRECT_JOB_CONFLICT', 'Manga upload session is already in use.', 'queue')
    }
    return {
      ok: true,
      code: 'MANGA_PAGE_V2_QUEUED',
      stage: 'queued',
      status: 'queued',
      job_id: previous.id,
      upload_id: claims.uploadId,
      source_bytes: claims.size,
      status_url: `/api/story-media/manga-page-v2/jobs/${previous.id}`,
    }
  }
  await checkImage(claims.key, claims.size, claims.mime)
  const bucket = bucketConfig().bucket
  await r2().send(new CopyObjectCommand({
    Bucket: bucket,
    Key: verifiedKey,
    CopySource: `${encodeURIComponent(bucket)}/${claims.key.split('/').map(encodeURIComponent).join('/')}`,
    MetadataDirective: 'REPLACE',
    ContentType: claims.mime,
    CacheControl: 'no-store, max-age=0',
  }))
  const job = await createHeavyMediaJob({
    userId: owner,
    jobType: 'manga_page_v2',
    tempObjectKey: verifiedKey,
    idempotencyKey: claims.uploadId,
    priority: 100,
    maxAttempts: 3,
    payload: {
      upload_id: claims.uploadId,
      source_bytes: claims.size,
      content_type: claims.mime,
      original_name: claims.name,
      intake: 'r2_direct',
    },
  })
  await deleteTemporary(claims.key).catch(() => {})
  return {
    ok: true,
    code: 'MANGA_PAGE_V2_QUEUED',
    stage: 'queued',
    status: 'queued',
    job_id: job.id,
    upload_id: claims.uploadId,
    source_bytes: claims.size,
    status_url: `/api/story-media/manga-page-v2/jobs/${job.id}`,
  }
}

export async function cancelMangaDirectUploadSession({ userId, uploadToken }) {
  const owner = requireOwner(userId)
  const claims = tokenClaims(uploadToken, owner)
  const previous = await existingJob(owner, claims.uploadId)
  if (previous) throw fail(409, 'MANGA_DIRECT_ALREADY_QUEUED', 'This Manga upload is already being processed.', 'cleanup')
  await deleteTemporary(claims.key)
  return { ok: true }
}
