import { createHmac, timingSafeEqual } from 'node:crypto'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const HASH = /^[0-9a-f]{64}$/
const PLACEMENTS = new Set(['stories', 'manga', 'discover'])
const SLOT_MS = 6 * 60 * 60 * 1000
const OFFSET_MS = 7 * 60 * 60 * 1000
const EVENT_GRACE_MS = 5 * 60 * 1000
const MAX_PROOF_LENGTH = 1024

export class SmartPdfEventProofError extends Error {
  constructor() {
    super('Invalid or expired PDF tracking proof')
    this.name = 'SmartPdfEventProofError'
    this.code = 'SMART_PDF_EVENT_PROOF_INVALID'
    this.statusCode = 403
  }
}

function reject() {
  throw new SmartPdfEventProofError()
}

function signingKey(secret) {
  if (typeof secret !== 'string' || !secret.trim()) {
    throw new Error('JWT_SECRET is required for PDF tracking proofs')
  }
  return createHmac('sha256', secret).update('shadow-smart-pdf-event-proof:v1').digest()
}

function validWindow(rotationKey) {
  const key = String(rotationKey || '')
  if (!/^\d{9,12}$/.test(key)) reject()
  const start = Number(key) * 1000
  if (!Number.isSafeInteger(start) || String(Math.floor(start / 1000)) !== key ||
      (start + OFFSET_MS) % SLOT_MS !== 0) reject()
  return { key, start, expires: start + SLOT_MS }
}

function digest(encoded, key) {
  return createHmac('sha256', key).update(encoded).digest()
}

export function issueSmartPdfEventProof({ readerHash, placement, productId, rotationKey, now = Date.now(), secret = process.env.JWT_SECRET } = {}) {
  if (!HASH.test(String(readerHash || '')) || !PLACEMENTS.has(placement) ||
      !UUID.test(String(productId || ''))) reject()
  const slot = validWindow(rotationKey)
  if (!Number.isFinite(now) || now < slot.start || now >= slot.expires) reject()
  const payload = {
    v: 1,
    reader: readerHash,
    placement,
    product_id: String(productId).toLowerCase(),
    rotation_key: slot.key,
    expires_at: slot.expires,
    issued_at: Math.floor(now / 1000),
  }
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${encoded}.${digest(encoded, signingKey(secret)).toString('base64url')}`
}

export function verifySmartPdfEventProof(token, {
  readerHash, placement, productId, rotationKey, now = Date.now(), secret = process.env.JWT_SECRET,
} = {}) {
  if (typeof token !== 'string' || token.length < 70 || token.length > MAX_PROOF_LENGTH ||
      !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) reject()
  const key = signingKey(secret)
  const [encoded, signature] = token.split('.')
  const actual = Buffer.from(signature, 'base64url')
  const expected = digest(encoded, key)
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) reject()
  let claims
  try {
    claims = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
  } catch {
    reject()
  }
  const slot = validWindow(rotationKey)
  if (!Number.isFinite(now) || now < slot.start || now >= slot.expires + EVENT_GRACE_MS ||
      claims?.v !== 1 || claims.reader !== readerHash || !HASH.test(String(claims.reader || '')) ||
      claims.placement !== placement || !PLACEMENTS.has(claims.placement) ||
      claims.product_id !== String(productId || '').toLowerCase() || !UUID.test(String(claims.product_id || '')) ||
      claims.rotation_key !== slot.key || claims.expires_at !== slot.expires ||
      !Number.isSafeInteger(claims.issued_at) || claims.issued_at < Math.floor(slot.start / 1000) ||
      claims.issued_at > Math.floor(Math.min(now, slot.expires - 1) / 1000) + 30) reject()
  return claims
}

export function attachSmartPdfEventProofs(selection, {
  readerHash, placement, now = Date.now(), secret = process.env.JWT_SECRET,
} = {}) {
  if (!selection || selection.ok !== true || !Array.isArray(selection.promotions) ||
      selection.promotions.length > 3 || !PLACEMENTS.has(placement)) reject()
  const promotions = selection.promotions.map((offer) => ({
    ...offer,
    smart_pdf_event_proof: issueSmartPdfEventProof({
      readerHash, placement, productId: offer.product_id,
      rotationKey: selection.rotation_key, now, secret,
    }),
  }))
  return { ...selection, promotions, promotion: promotions[0] || null }
}
