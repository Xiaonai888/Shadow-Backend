import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { createReadStream } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { assertDiskBackedUploadFile } from './mediaStoragePolicy.service.js'

const MAX_BYTES = 5 * 1024 * 1024
let client

function storageError(message, statusCode = 400) {
  const error = new Error(message)
  error.statusCode = statusCode
  return error
}

function config() {
  const accountId = String(process.env.R2_ACCOUNT_ID || '').trim()
  const accessKeyId = String(process.env.R2_PRIVATE_ACCESS_KEY_ID || process.env.R2_ACCESS_KEY_ID || '').trim()
  const secretAccessKey = String(process.env.R2_PRIVATE_SECRET_ACCESS_KEY || process.env.R2_SECRET_ACCESS_KEY || '').trim()
  const bucket = String(process.env.R2_PRIVATE_BUCKET_NAME || '').trim()
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) throw storageError('Private shipping proof storage is unavailable', 503)
  if (!client) client = new S3Client({ region: 'auto', endpoint: `https://${accountId}.r2.cloudflarestorage.com`, credentials: { accessKeyId, secretAccessKey } })
  return { client, bucket }
}

function mimeFromHeader(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png'
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  return ''
}

function ownedKey(authorPageId, holdId, key) {
  const prefix = `author-book-shipping-proofs/${authorPageId}/${holdId}/`
  if (!String(key || '').startsWith(prefix) || !/^author-book-shipping-proofs\/[0-9a-f-]+\/[0-9a-f-]+\/[0-9a-f-]+\.(?:jpg|png|webp)$/i.test(String(key))) {
    throw storageError('Invalid private shipping proof', 404)
  }
  return String(key)
}

export async function uploadPrivateBookShippingProof({ authorPageId, holdId, file }) {
  assertDiskBackedUploadFile(file, { field: 'shipping_proof', allowEmpty: false })
  const originalPath = String(file.path || '')
  const basename = path.basename(originalPath)
  if (!path.isAbsolute(originalPath) || path.dirname(originalPath) !== path.resolve(os.tmpdir()) || !/^[0-9a-f]{32}$/i.test(basename)) {
    throw storageError('Invalid shipping proof upload path')
  }
  const tempDirectory = await realpath(os.tmpdir())
  const realFile = await realpath(originalPath)
  const stat = await lstat(realFile)
  if (path.dirname(realFile) !== tempDirectory || !stat.isFile() || stat.isSymbolicLink() || stat.size < 16 || stat.size > MAX_BYTES) {
    throw storageError('Shipping proof file is invalid or exceeds 5 MB')
  }
  const handle = await open(realFile, 'r')
  const header = Buffer.alloc(12)
  try {
    await handle.read(header, 0, 12, 0)
  } finally {
    await handle.close()
  }
  const mimeType = mimeFromHeader(header)
  if (!mimeType || mimeType !== String(file.mimetype || '').toLowerCase()) throw storageError('Only valid JPEG, PNG and WebP proof images are supported')
  const extension = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[mimeType]
  const storageKey = `author-book-shipping-proofs/${authorPageId}/${holdId}/${randomUUID()}.${extension}`
  const { client: storageClient, bucket } = config()
  await storageClient.send(new PutObjectCommand({
    Bucket: bucket,
    Key: storageKey,
    Body: createReadStream(realFile),
    ContentLength: stat.size,
    ContentType: mimeType,
    ContentDisposition: 'inline',
    CacheControl: 'private, no-store, no-cache, must-revalidate',
  }))
  return { storageKey, mimeType, sizeBytes: stat.size }
}

export async function readPrivateBookShippingProof({ authorPageId, holdId, storageKey }) {
  const { client: storageClient, bucket } = config()
  return storageClient.send(new GetObjectCommand({ Bucket: bucket, Key: ownedKey(authorPageId, holdId, storageKey) }))
}

export async function deletePrivateBookShippingProof({ authorPageId, holdId, storageKey }) {
  const { client: storageClient, bucket } = config()
  await storageClient.send(new DeleteObjectCommand({ Bucket: bucket, Key: ownedKey(authorPageId, holdId, storageKey) }))
}
