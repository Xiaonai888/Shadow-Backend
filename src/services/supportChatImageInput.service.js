import { randomUUID } from 'node:crypto'

export const MAX_SUPPORT_IMAGE_BYTES = 2 * 1024 * 1024
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const TYPES = Object.freeze({ 'image/webp': 'webp', 'image/jpeg': 'jpg', 'image/png': 'png' })
const KEY = /^support-chat-(temp|media)\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(webp|jpg|png)$/

export function parseSupportImageInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const mime = body.mime_type
  const size = body.file_size
  if (typeof mime !== 'string' || !Object.hasOwn(TYPES, mime) || !Number.isSafeInteger(size) || size < 32 || size > MAX_SUPPORT_IMAGE_BYTES) return null
  return { mime, size, extension: TYPES[mime] }
}

export function makeSupportImageKey(kind, mime, id = randomUUID()) {
  if (!['temp', 'media'].includes(kind) || !Object.hasOwn(TYPES, mime) || typeof id !== 'string' || !UUID.test(id)) throw new Error('Invalid support image key input')
  return `support-chat-${kind}/${id.toLowerCase()}.${TYPES[mime]}`
}

export function validateSupportImageKey(key, kind, mime) {
  if (typeof key !== 'string' || !['temp', 'media'].includes(kind)) return false
  const match = KEY.exec(key)
  return Boolean(match && match[1] === kind && (mime === undefined || (Object.hasOwn(TYPES, mime) && match[2] === TYPES[mime])))
}

export function matchesSupportImageHeader(bytes, mime) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 16) return false
  const b = Buffer.from(bytes)
  if (mime === 'image/webp') return b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP' && ['VP8 ', 'VP8L', 'VP8X'].includes(b.toString('ascii', 12, 16))
  if (mime === 'image/jpeg') return b[0] === 255 && b[1] === 216 && b[2] === 255
  if (mime === 'image/png') return b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && b.readUInt32BE(8) === 13 && b.toString('ascii', 12, 16) === 'IHDR'
  return false
}
