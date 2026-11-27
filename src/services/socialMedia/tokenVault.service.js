import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

function keyFromEnv() {
  const value = process.env.SOCIAL_MEDIA_TOKEN_KEY || ''
  if (!/^[a-fA-F0-9]{64}$/.test(value)) throw new Error('SOCIAL_MEDIA_KEY_INVALID')
  return Buffer.from(value, 'hex')
}

function contextBytes(context) {
  const { ownerType, ownerId, platform, externalId } = context || {}
  if (!['admin', 'author'].includes(ownerType) || typeof ownerId !== 'string' || !ownerId || ownerId.length > 128 || (ownerType === 'admin' && ownerId !== 'shadow') || !['facebook', 'instagram'].includes(platform) || typeof externalId !== 'string' || !/^[0-9]{1,40}$/.test(externalId)) throw new Error('SOCIAL_MEDIA_CONTEXT_INVALID')
  return Buffer.from(JSON.stringify(['v1', ownerType, ownerId, platform, externalId]), 'utf8')
}

export function encryptSocialToken(token, context) {
  if (typeof token !== 'string' || !token.trim() || token.length > 16384) throw new Error('SOCIAL_MEDIA_TOKEN_INVALID')
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', keyFromEnv(), iv)
  cipher.setAAD(contextBytes(context))
  const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()])
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join('.')
}

export function decryptSocialToken(value, context) {
  const key = keyFromEnv()
  const aad = contextBytes(context)
  try {
    if (typeof value !== 'string' || value.length > 100000) throw new Error()
    const parts = value.split('.')
    if (parts.length !== 4 || parts[0] !== 'v1' || !parts.slice(1).every(part => /^[A-Za-z0-9_-]+$/.test(part))) throw new Error()
    const [iv, tag, ciphertext] = parts.slice(1).map(part => Buffer.from(part, 'base64url'))
    if (iv.length !== 12 || tag.length !== 16 || !ciphertext.length) throw new Error()
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAAD(aad)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
  } catch {
    throw new Error('SOCIAL_MEDIA_TOKEN_DECRYPT_FAILED')
  }
}
