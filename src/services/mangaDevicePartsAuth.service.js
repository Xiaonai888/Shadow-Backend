import { randomUUID } from 'node:crypto'
import jwt from 'jsonwebtoken'
import { mangaDevicePartsError, MANGA_DEVICE_PARTS_LIMITS } from './mangaDevicePartsPolicy.service.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const AUDIENCE = 'shadow-manga-device-parts'
const ISSUER = 'shadow-backend'

export function assertMangaDevicePartsEnabled() {
  if (
    process.env.MANGA_DEVICE_PARTS_ENABLED !== 'true' ||
    process.env.MANGA_DIRECT_UPLOAD_ENABLED !== 'true'
  ) {
    throw mangaDevicePartsError(503, 'MANGA_DEVICE_PARTS_DISABLED', 'Device-first Manga upload is disabled', 'init')
  }
  if (!process.env.JWT_SECRET) {
    throw mangaDevicePartsError(503, 'MANGA_DEVICE_PARTS_UNAVAILABLE', 'Manga upload signing is not configured', 'init')
  }
}

export function requireMangaDeviceOwner(userId) {
  const owner = String(userId || '').trim()
  if (!UUID.test(owner)) {
    throw mangaDevicePartsError(401, 'MANGA_DEVICE_UNAUTHORIZED', 'Sign in to upload Manga', 'auth')
  }
  return owner
}

export function createMangaDevicePartsIdentity(userId) {
  const owner = requireMangaDeviceOwner(userId)
  return { owner, sessionId: randomUUID() }
}

export function signMangaDevicePartsToken({ owner, sessionId }) {
  const safeOwner = requireMangaDeviceOwner(owner)
  if (!UUID.test(String(sessionId || ''))) {
    throw mangaDevicePartsError(422, 'MANGA_DEVICE_SESSION_INVALID', 'Manga session is invalid', 'init')
  }
  return jwt.sign({ v: 1, purpose: 'manga_device_parts', owner: safeOwner, sessionId }, process.env.JWT_SECRET, {
    issuer: ISSUER,
    audience: AUDIENCE,
    expiresIn: MANGA_DEVICE_PARTS_LIMITS.maxSessionSeconds,
    algorithm: 'HS256',
  })
}

export function verifyMangaDevicePartsToken({ userId, uploadToken }) {
  const owner = requireMangaDeviceOwner(userId)
  let claims
  try {
    claims = jwt.verify(String(uploadToken || ''), process.env.JWT_SECRET, {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ['HS256'],
    })
  } catch {
    throw mangaDevicePartsError(401, 'MANGA_DEVICE_TOKEN_INVALID', 'Manga upload session expired or is invalid', 'auth')
  }
  if (
    claims?.v !== 1 || claims?.purpose !== 'manga_device_parts' ||
    claims?.owner !== owner || !UUID.test(String(claims?.sessionId || ''))
  ) {
    throw mangaDevicePartsError(403, 'MANGA_DEVICE_OWNER_MISMATCH', 'Manga upload session belongs to another account', 'auth')
  }
  return { owner, sessionId: claims.sessionId }
}
