import { S3Client, HeadObjectCommand, GetObjectCommand, CopyObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3'
import { makeSupportImageKey, parseSupportImageInput, validateSupportImageKey, matchesSupportImageHeader } from './supportChatImageInput.service.js'
import { signSupportImageUrl } from './supportChatPrivateR2Signing.service.js'

let client

function config() {
  const value = {
    accountId: String(process.env.R2_ACCOUNT_ID || '').trim(),
    accessKeyId: String(process.env.R2_PRIVATE_ACCESS_KEY_ID || '').trim(),
    secretAccessKey: String(process.env.R2_PRIVATE_SECRET_ACCESS_KEY || '').trim(),
    bucket: String(process.env.R2_PRIVATE_BUCKET_NAME || '').trim(),
  }
  if (!value.accountId || !value.accessKeyId || !value.secretAccessKey || !value.bucket || value.bucket === String(process.env.R2_BUCKET_NAME || '').trim()) throw new Error('Dedicated private R2 bucket required')
  return value
}

function r2(c) {
  if (!client) client = new S3Client({ region: 'auto', endpoint: `https://${c.accountId}.r2.cloudflarestorage.com`, credentials: { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey }, maxAttempts: 2 })
  return client
}

function send(c, command) {
  return r2(c).send(command, { abortSignal: AbortSignal.timeout(12000) })
}

function invalid() {
  return Object.assign(new Error('Invalid uploaded support image'), { statusCode: 400, code: 'SUPPORT_IMAGE_INVALID' })
}

export function createPrivateSupportImageUpload(body) {
  const input = parseSupportImageInput(body)
  if (!input) throw invalid()
  const key = makeSupportImageKey('temp', input.mime)
  return { key, mime: input.mime, size: input.size, upload_url: signSupportImageUrl(config(), { method: 'PUT', key, mime: input.mime, size: input.size }), expires_in_seconds: 300 }
}

export async function promotePrivateSupportImage({ key, mime, size }) {
  if (!validateSupportImageKey(key, 'temp', mime) || !parseSupportImageInput({ mime_type: mime, file_size: size })) throw invalid()
  const c = config()
  const head = await send(c, new HeadObjectCommand({ Bucket: c.bucket, Key: key }))
  if (!head.ETag || Number(head.ContentLength) !== size || head.ContentType !== mime) throw invalid()
  const object = await send(c, new GetObjectCommand({ Bucket: c.bucket, Key: key, Range: 'bytes=0-31', IfMatch: head.ETag }))
  if (Number(object.ContentLength) !== 32 || object.ETag !== head.ETag || !object.Body) {
    object.Body?.destroy?.()
    throw invalid()
  }
  const header = await object.Body.transformToByteArray()
  if (header.length !== 32 || !matchesSupportImageHeader(header, mime)) throw invalid()
  const finalKey = makeSupportImageKey('media', mime)
  await send(c, new CopyObjectCommand({ Bucket: c.bucket, Key: finalKey, CopySource: `${c.bucket}/${key}`, CopySourceIfMatch: head.ETag, MetadataDirective: 'REPLACE', ContentType: mime, CacheControl: 'private, no-store', ContentDisposition: 'inline' }))
  return { type: 'image', storage_key: finalKey, mime_type: mime, file_size: size }
}

export function getPrivateSupportImageReadUrl(key) {
  if (!validateSupportImageKey(key, 'media')) throw invalid()
  return { url: signSupportImageUrl(config(), { method: 'GET', key }), expires_in_seconds: 120 }
}

export async function deletePrivateSupportImage(key, kind) {
  if (!validateSupportImageKey(key, kind)) throw invalid()
  const c = config()
  await send(c, new DeleteObjectCommand({ Bucket: c.bucket, Key: key }))
}
