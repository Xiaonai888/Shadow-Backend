import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { parseSupportImageInput, validateSupportImageKey } from './supportChatImageInput.service.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
export const isSupportImageId = value => typeof value === 'string' && UUID.test(value)
export const supportImageError = (statusCode, code) => Object.assign(new Error(code), { statusCode, code })

export function supportImageActor(kind, id, role = null) {
  if (!['reader', 'admin'].includes(kind) || !isSupportImageId(String(id || '')) || (kind === 'admin' && !['owner', 'admin', 'staff'].includes(role))) throw supportImageError(403, 'SUPPORT_IMAGE_FORBIDDEN')
  return { kind, id: String(id).toLowerCase(), role }
}

function mac(secret, payload) {
  if (!secret) throw new Error('Missing JWT_SECRET')
  return createHmac('sha256', secret).update('shadow-support-image-v1:').update(payload).digest()
}

export function issueSupportImageToken(actor, conversationId, upload, { secret = process.env.JWT_SECRET, now = Date.now(), messageId = randomUUID() } = {}) {
  if ((conversationId !== null && !isSupportImageId(conversationId)) || (actor.kind === 'admin' && !conversationId) || !isSupportImageId(messageId) || !parseSupportImageInput({ mime_type: upload.mime, file_size: upload.size }) || !validateSupportImageKey(upload.key, 'temp', upload.mime)) throw supportImageError(400, 'SUPPORT_IMAGE_INVALID')
  const claims = { v: 1, kind: actor.kind, actor: actor.id, conversationId, messageId, key: upload.key, mime: upload.mime, size: upload.size, exp: now + 12 * 60 * 1000 }
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
  return { token: `${payload}.${mac(secret, payload).toString('base64url')}`, messageId }
}

export function verifySupportImageToken(token, actor, conversationId, { secret = process.env.JWT_SECRET, now = Date.now() } = {}) {
  const invalid = () => { throw supportImageError(400, 'SUPPORT_IMAGE_TOKEN_INVALID') }
  if (typeof token !== 'string' || token.length > 2048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) invalid()
  const [payload, signature] = token.split('.')
  const expected = mac(secret, payload)
  const actual = Buffer.from(signature, 'base64url')
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) invalid()
  let c
  try { c = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) } catch { invalid() }
  if (c?.v !== 1 || c.kind !== actor.kind || c.actor !== actor.id || c.conversationId !== conversationId || !isSupportImageId(c.messageId) || !Number.isSafeInteger(c.exp) || c.exp <= now || !parseSupportImageInput({ mime_type: c.mime, file_size: c.size }) || !validateSupportImageKey(c.key, 'temp', c.mime)) invalid()
  return c
}

export function parseSupportImageCaption(value) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || value.length > 2000) throw supportImageError(400, 'SUPPORT_IMAGE_CAPTION_INVALID')
  return value.trim() || null
}
