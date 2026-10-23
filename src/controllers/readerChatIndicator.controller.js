import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { S3Client, HeadObjectCommand, GetObjectCommand, CopyObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3'
import sharp from 'sharp'
import { supabase } from '../config/supabase.js'
import { createPresignedPutUrl } from '../services/storyVideoDirectUpload.service.js'

const TABLE = 'reader_chat_indicator_images'
const FIELDS = 'reader_id,id,storage_key,image_url,mime_type,file_size,width,height,pending_id,pending_storage_key,pending_mime_type,pending_file_size,pending_token_hash,pending_expires_at,created_at,updated_at'
const EXTENSIONS = Object.freeze({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' })
const MAX_BYTES = 5242880
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const EMPTY_PENDING = Object.freeze({ pending_id: null, pending_storage_key: null, pending_mime_type: null, pending_file_size: null, pending_token_hash: null, pending_expires_at: null })
const EMPTY_ACTIVE = Object.freeze({ id: null, storage_key: null, image_url: null, mime_type: null, file_size: null, width: null, height: null })
let client

function fail(statusCode, code) {
  return Object.assign(new Error(code), { statusCode, code })
}

function owner(req) {
  const id = req.user?.user_id
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw fail(401, 'CHAT_INDICATOR_UNAUTHORIZED')
  return id
}

function config() {
  const bucket = String(process.env.R2_BUCKET_NAME || '').trim()
  const account = String(process.env.R2_ACCOUNT_ID || '').trim()
  const accessKeyId = String(process.env.R2_ACCESS_KEY_ID || '').trim()
  const secretAccessKey = String(process.env.R2_SECRET_ACCESS_KEY || '').trim()
  const publicUrl = String(process.env.R2_PUBLIC_URL || '').trim().replace(/\/+$/, '')
  try {
    const url = new URL(publicUrl)
    if (!bucket || !/^[a-zA-Z0-9_-]+$/.test(account) || !accessKeyId || !secretAccessKey || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error()
  } catch {
    throw fail(503, 'CHAT_INDICATOR_STORAGE_UNAVAILABLE')
  }
  return { bucket, account, accessKeyId, secretAccessKey, publicUrl }
}

function send(command) {
  if (!client) {
    const c = config()
    client = new S3Client({ region: 'auto', endpoint: `https://${c.account}.r2.cloudflarestorage.com`, credentials: { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey }, maxAttempts: 2 })
  }
  return client.send(command, { abortSignal: AbortSignal.timeout(15000) })
}

async function checked(query) {
  const result = await query
  if (result.error) throw result.error
  return result.data
}

function readRow(id) {
  return checked(supabase.from(TABLE).select(FIELDS).eq('reader_id', id).maybeSingle())
}

function imageItem(row) {
  return row?.id ? { id: row.id, image_url: row.image_url, width: row.width, height: row.height, updated_at: row.updated_at } : null
}

function tempKey(readerId, id, mime) {
  return `media-direct-temp/user/${readerId}/chat-indicators/${id}.${EXTENSIONS[mime]}`
}

function finalKey(readerId, id, mime) {
  return `reader-chat-indicators/${readerId}/${id}.${EXTENSIONS[mime]}`
}

function assertKeys(row) {
  if (row.id && (!UUID.test(row.id) || !EXTENSIONS[row.mime_type] || row.storage_key !== finalKey(row.reader_id, row.id, row.mime_type))) throw fail(503, 'CHAT_INDICATOR_STORAGE_INVALID')
  if (row.pending_id && (!UUID.test(row.pending_id) || !EXTENSIONS[row.pending_mime_type] || row.pending_storage_key !== tempKey(row.reader_id, row.pending_id, row.pending_mime_type))) throw fail(503, 'CHAT_INDICATOR_STORAGE_INVALID')
}

function samePending(query, row) {
  return row.pending_id ? query.eq('pending_id', row.pending_id) : query.is('pending_id', null)
}

async function removeObject(key) {
  if (key) await send(new DeleteObjectCommand({ Bucket: config().bucket, Key: key }))
}

async function cleanupObject(key) {
  try {
    await removeObject(key)
  } catch {
    console.error('CHAT_INDICATOR_OBJECT_CLEANUP_FAILED')
  }
}

export async function getChatTapIndicatorImage(req, res) {
  const row = await readRow(owner(req))
  res.set('Cache-Control', 'private, no-store')
  return res.json({ ok: true, item: imageItem(row) })
}

export async function initiateChatTapIndicatorImage(req, res) {
  const readerId = owner(req)
  if (String(process.env.MEDIA_DIRECT_UPLOAD_ENABLED || '').toLowerCase() !== 'true') throw fail(503, 'CHAT_INDICATOR_UPLOAD_DISABLED')
  config()
  const mime = req.body?.mime_type
  const size = req.body?.file_size
  if (typeof mime !== 'string' || !Object.hasOwn(EXTENSIONS, mime)) throw fail(415, 'CHAT_INDICATOR_TYPE_INVALID')
  if (!Number.isSafeInteger(size) || size < 16 || size > MAX_BYTES) throw fail(413, 'CHAT_INDICATOR_SIZE_INVALID')
  const inserted = await supabase.from(TABLE).upsert({ reader_id: readerId }, { onConflict: 'reader_id', ignoreDuplicates: true })
  if (inserted.error) throw inserted.error
  const row = await readRow(readerId)
  if (!row) throw fail(503, 'CHAT_INDICATOR_UNAVAILABLE')
  assertKeys(row)
  if (row.pending_id && Date.parse(row.pending_expires_at) > Date.now()) throw fail(409, 'CHAT_INDICATOR_UPLOAD_BUSY')
  const uploadId = randomUUID()
  const key = tempKey(readerId, uploadId, mime)
  const token = randomBytes(32).toString('base64url')
  const hash = createHash('sha256').update(token).digest('hex')
  const uploadUrl = createPresignedPutUrl(key, mime, 300, size)
  const updated = await checked(samePending(supabase.from(TABLE).update({
    pending_id: uploadId,
    pending_storage_key: key,
    pending_mime_type: mime,
    pending_file_size: size,
    pending_token_hash: hash,
    pending_expires_at: new Date(Date.now() + 900000).toISOString(),
    updated_at: new Date().toISOString(),
  }).eq('reader_id', readerId), row).select('reader_id').maybeSingle())
  if (!updated) throw fail(409, 'CHAT_INDICATOR_UPLOAD_BUSY')
  if (row.pending_storage_key) await cleanupObject(row.pending_storage_key)
  return res.status(201).json({ ok: true, upload_id: uploadId, upload_url: uploadUrl, upload_token: token, expires_in_seconds: 300, max_bytes: MAX_BYTES, required_headers: { 'Content-Type': mime } })
}

async function verifyImage(row) {
  const params = { Bucket: config().bucket, Key: row.pending_storage_key }
  const head = await send(new HeadObjectCommand(params))
  if (Number(head.ContentLength) !== row.pending_file_size || head.ContentType !== row.pending_mime_type || !head.ETag) throw fail(400, 'CHAT_INDICATOR_FILE_MISMATCH')
  const response = await send(new GetObjectCommand({ ...params, IfMatch: head.ETag }))
  const chunks = []
  let length = 0
  try {
    for await (const chunk of response.Body) {
      length += chunk.length
      if (length > MAX_BYTES || length > row.pending_file_size) throw fail(413, 'CHAT_INDICATOR_SIZE_INVALID')
      chunks.push(Buffer.from(chunk))
    }
  } finally {
    response.Body?.destroy?.()
  }
  if (length !== row.pending_file_size) throw fail(400, 'CHAT_INDICATOR_FILE_MISMATCH')
  const bytes = Buffer.concat(chunks, length)
  try {
    const decoder = sharp(bytes, { limitInputPixels: 512 * 512, failOn: 'warning' })
    const meta = await decoder.metadata()
    const format = { 'image/jpeg': 'jpeg', 'image/png': 'png', 'image/webp': 'webp' }[row.pending_mime_type]
    if (meta.format !== format || !meta.width || meta.width > 512 || meta.height !== meta.width || (meta.pages || 1) !== 1) throw new Error()
    await decoder.stats()
    return { etag: head.ETag, width: meta.width, height: meta.height }
  } catch {
    throw fail(415, 'CHAT_INDICATOR_IMAGE_INVALID')
  }
}

export async function completeChatTapIndicatorImage(req, res) {
  const readerId = owner(req)
  const uploadId = req.body?.upload_id
  const token = req.body?.upload_token
  if (typeof uploadId !== 'string' || !UUID.test(uploadId) || typeof token !== 'string' || !/^[a-zA-Z0-9_-]{43}$/.test(token)) throw fail(400, 'CHAT_INDICATOR_TOKEN_INVALID')
  const hash = createHash('sha256').update(token).digest('hex')
  const row = await readRow(readerId)
  if (row?.id === uploadId) return res.json({ ok: true, item: imageItem(row) })
  if (!row || row.pending_id !== uploadId || row.pending_token_hash !== hash) throw fail(404, 'CHAT_INDICATOR_UPLOAD_NOT_FOUND')
  if (Date.parse(row.pending_expires_at) <= Date.now()) throw fail(410, 'CHAT_INDICATOR_UPLOAD_EXPIRED')
  assertKeys(row)
  let verified
  try {
    verified = await verifyImage(row)
  } catch (error) {
    const current = await readRow(readerId)
    if (current?.id === uploadId) return res.json({ ok: true, item: imageItem(current) })
    if (error?.$metadata?.httpStatusCode === 404 || error.name === 'NoSuchKey' || error.name === 'NotFound') throw fail(400, 'CHAT_INDICATOR_UPLOAD_MISSING')
    throw error
  }
  const c = config()
  const key = finalKey(readerId, uploadId, row.pending_mime_type)
  await send(new CopyObjectCommand({ Bucket: c.bucket, Key: key, CopySource: `${encodeURIComponent(c.bucket)}/${row.pending_storage_key.split('/').map(encodeURIComponent).join('/')}`, CopySourceIfMatch: verified.etag, MetadataDirective: 'REPLACE', ContentType: row.pending_mime_type, CacheControl: 'public, max-age=31536000, immutable' }))
  const changes = {
    ...EMPTY_PENDING,
    id: uploadId,
    storage_key: key,
    image_url: `${c.publicUrl}/${key}`,
    mime_type: row.pending_mime_type,
    file_size: row.pending_file_size,
    width: verified.width,
    height: verified.height,
    updated_at: new Date().toISOString(),
  }
  const result = await supabase.from(TABLE).update(changes).eq('reader_id', readerId).eq('pending_id', uploadId).eq('pending_token_hash', hash).select(FIELDS).maybeSingle()
  if (result.error) throw result.error
  if (!result.data) {
    const current = await readRow(readerId)
    if (current?.id === uploadId) return res.json({ ok: true, item: imageItem(current) })
    await cleanupObject(key)
    throw fail(409, 'CHAT_INDICATOR_UPLOAD_CHANGED')
  }
  await cleanupObject(row.pending_storage_key)
  if (row.storage_key && row.storage_key !== key) await cleanupObject(row.storage_key)
  return res.status(201).json({ ok: true, item: imageItem(result.data) })
}

export async function cancelChatTapIndicatorUpload(req, res) {
  const readerId = owner(req)
  const uploadId = req.body?.upload_id
  const token = req.body?.upload_token
  if (typeof uploadId !== 'string' || !UUID.test(uploadId) || typeof token !== 'string' || !/^[a-zA-Z0-9_-]{43}$/.test(token)) throw fail(400, 'CHAT_INDICATOR_TOKEN_INVALID')
  const hash = createHash('sha256').update(token).digest('hex')
  const row = await readRow(readerId)
  if (!row || row.pending_id !== uploadId || row.pending_token_hash !== hash) return res.json({ ok: true })
  assertKeys(row)
  const changed = await checked(supabase.from(TABLE).update({ ...EMPTY_PENDING, updated_at: new Date().toISOString() }).eq('reader_id', readerId).eq('pending_id', uploadId).eq('pending_token_hash', hash).select('reader_id').maybeSingle())
  if (changed) await cleanupObject(row.pending_storage_key)
  return res.json({ ok: true })
}

export async function deleteChatTapIndicatorImage(req, res) {
  const readerId = owner(req)
  const id = req.params?.id
  if (typeof id !== 'string' || !UUID.test(id)) throw fail(400, 'CHAT_INDICATOR_ID_INVALID')
  const row = await readRow(readerId)
  if (!row || row.id !== id) throw fail(404, 'CHAT_INDICATOR_IMAGE_NOT_FOUND')
  assertKeys(row)
  const changed = await checked(samePending(supabase.from(TABLE).update({ ...EMPTY_ACTIVE, ...EMPTY_PENDING, updated_at: new Date().toISOString() }).eq('reader_id', readerId).eq('id', id), row).select('reader_id').maybeSingle())
  if (!changed) throw fail(409, 'CHAT_INDICATOR_UPLOAD_CHANGED')
  await cleanupObject(row.storage_key)
  await cleanupObject(row.pending_storage_key)
  return res.json({ ok: true })
}
