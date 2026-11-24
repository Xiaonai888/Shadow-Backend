import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import { gzip, gunzip } from 'node:zlib'
import { promisify } from 'node:util'

const compress = promisify(gzip)
const decompress = promisify(gunzip)
const MAX_RAW = 2 * 1024 * 1024
const MAX_COMPRESSED = 512 * 1024
let client
let identity

function configuration() {
  const account = String(process.env.R2_ACCOUNT_ID || '').trim()
  const bucket = String(process.env.DATABASE_IO_PRIVATE_R2_BUCKET || '').trim()
  const accessKeyId = String(process.env.DATABASE_IO_R2_ACCESS_KEY_ID || '').trim()
  const secretAccessKey = String(process.env.DATABASE_IO_R2_SECRET_ACCESS_KEY || '').trim()
  if (!/^[a-f0-9]{32}$/i.test(account) || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket) || !accessKeyId || !secretAccessKey || bucket === process.env.R2_BUCKET_NAME || bucket === process.env.CLOUDFLARE_R2_BUCKET) return null
  return { account, bucket, accessKeyId, secretAccessKey }
}

export function databaseIoArchiveConfigured() { return Boolean(configuration()) }

function connection() {
  const cfg = configuration()
  if (!cfg) throw new Error('IO_ARCHIVE_NOT_CONFIGURED')
  const key = `${cfg.account}:${cfg.bucket}:${cfg.accessKeyId}:${cfg.secretAccessKey}`
  if (!client || identity !== key) {
    client?.destroy()
    client = new S3Client({ region: 'auto', endpoint: `https://${cfg.account}.r2.cloudflarestorage.com`, credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey }, maxAttempts: 1 })
    identity = key
  }
  return { client, bucket: cfg.bucket }
}

function objectKey(key) {
  if (!/^database-io\/v1\/(detail|daily)\/\d{4}-\d{2}-\d{2}(?:\/\d{13}-\d{13})?\.json\.gz$/.test(key)) throw new Error('IO_ARCHIVE_INVALID_KEY')
  return key
}

export async function writeDatabaseIoObject(key, value) {
  const { client, bucket } = connection()
  const raw = Buffer.from(JSON.stringify(value))
  if (raw.length > MAX_RAW) throw new Error('IO_ARCHIVE_RAW_LIMIT')
  const body = await compress(raw)
  if (body.length > MAX_COMPRESSED) throw new Error('IO_ARCHIVE_COMPRESSED_LIMIT')
  await client.send(new PutObjectCommand({ Bucket: bucket, Key: objectKey(key), Body: body, ContentType: 'application/gzip', CacheControl: 'no-store, private' }), { abortSignal: AbortSignal.timeout(8000) })
}

export async function readDatabaseIoObject(key) {
  const { client, bucket } = connection()
  const signal = AbortSignal.timeout(8000)
  let result
  try {
    result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: objectKey(key) }), { abortSignal: signal })
  } catch (error) {
    if (error?.name === 'NoSuchKey') return null
    throw error
  }
  if (!result.Body) throw new Error('IO_ARCHIVE_EMPTY_BODY')
  const chunks = []
  let size = 0
  const abort = () => result.Body.destroy?.()
  signal.addEventListener('abort', abort, { once: true })
  try {
    if (signal.aborted || Number(result.ContentLength) > MAX_COMPRESSED) throw new Error('IO_ARCHIVE_READ_LIMIT')
    for await (const chunk of result.Body) {
      if (signal.aborted) throw new Error('IO_ARCHIVE_READ_TIMEOUT')
      size += chunk.length
      if (size > MAX_COMPRESSED) throw new Error('IO_ARCHIVE_READ_LIMIT')
      chunks.push(Buffer.from(chunk))
    }
    const raw = await decompress(Buffer.concat(chunks), { maxOutputLength: MAX_RAW })
    return JSON.parse(raw.toString('utf8'))
  } finally {
    signal.removeEventListener('abort', abort)
    result.Body.destroy?.()
  }
}
