import { createHmac, timingSafeEqual } from 'node:crypto'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const VALID_PLACEMENTS = new Set(['stories', 'manga', 'discover'])
const VALID_LANGUAGES = new Set(['km', 'en', 'zh', 'ja', 'ko'])
const SLOT_MS = 6 * 60 * 60 * 1000
const OFFSET_MS = 7 * 60 * 60 * 1000
const MAX_TOKEN_LENGTH = 2048

export class SmartPdfOfferTokenError extends Error {
  constructor(message = 'PDF promotion is no longer valid') {
    super(message)
    this.name = 'SmartPdfOfferTokenError'
    this.code = 'SMART_PDF_PROMOTION_INVALID'
    this.statusCode = 409
  }
}

function fail() {
  throw new SmartPdfOfferTokenError()
}

function keyOf(secret) {
  const value = typeof secret === 'string' ? secret : ''
  if (!value) throw new Error('JWT_SECRET is required for PDF offer signatures')
  return createHmac('sha256', value).update('shadow-smart-pdf-offer-signature:v1').digest()
}

function readerHash(readerId, key) {
  const id = String(readerId || '').trim().toLowerCase()
  if (!UUID.test(id)) fail()
  return createHmac('sha256', key).update(`shadow-smart-pdf-buyer:v1:${id}`).digest('hex')
}

function slotAt(now) {
  const n = Number(now)
  if (!Number.isFinite(n)) fail()
  const start = Math.floor((n + OFFSET_MS) / SLOT_MS) * SLOT_MS - OFFSET_MS
  return { rotationKey: String(Math.floor(start / 1000)), expiresAt: start + SLOT_MS }
}

function cents(value) {
  if (value === null || value === undefined || value === '') fail()
  const amount = Number(value)
  const rounded = Math.round(amount * 100)
  if (!Number.isFinite(amount) || amount <= 0 || !Number.isSafeInteger(rounded) || Math.abs(amount * 100 - rounded) > 0.001) fail()
  return rounded
}

function signature(payload, key) {
  return createHmac('sha256', key).update(payload).digest()
}

export function issueSmartPdfOfferToken(offer, {
  readerId, placement, now = Date.now(), secret = process.env.JWT_SECRET,
} = {}) {
  const key = keyOf(secret)
  const slot = slotAt(now)
  const productId = String(offer?.product_id || '').toLowerCase()
  const authorPageId = String(offer?.author_page_id || '').toLowerCase()
  const language = String(offer?.story_language || '')
  const original = cents(offer?.original_price_usd)
  const author = cents(offer?.author_price_usd)
  const promotion = cents(offer?.promotion_price_usd)
  const expiry = Date.parse(String(offer?.expires_at || ''))
  if (!UUID.test(productId) || !UUID.test(authorPageId) || !VALID_LANGUAGES.has(language) ||
      !VALID_PLACEMENTS.has(placement) || offer?.product_type !== 'pdf' ||
      String(offer?.discount_source) !== 'author' ||
      author > original || promotion !== author ||
      promotion > Math.max(1, Math.floor(original * 0.8)) ||
      expiry !== slot.expiresAt || String(offer?.rotation_key || slot.rotationKey) !== slot.rotationKey ||
      now >= slot.expiresAt) fail()
  const payload = {
    v: 1,
    buyer: readerHash(readerId, key),
    product_id: productId,
    author_page_id: authorPageId,
    language,
    placement,
    original_cents: original,
    author_cents: author,
    promotion_cents: promotion,
    rotation_key: slot.rotationKey,
    expires_at: slot.expiresAt,
    issued_at: Math.floor(now / 1000),
  }
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${encoded}.${signature(encoded, key).toString('base64url')}`
}

export function verifySmartPdfOfferToken(token, {
  readerId, now = Date.now(), secret = process.env.JWT_SECRET,
} = {}) {
  if (typeof token !== 'string' || token.length < 60 || token.length > MAX_TOKEN_LENGTH ||
      !/^[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+$/.test(token)) fail()
  const key = keyOf(secret)
  const [encoded, provided] = token.split('.')
  const providedBytes = Buffer.from(provided, 'base64url')
  const expected = signature(encoded, key)
  if (providedBytes.length !== expected.length || !timingSafeEqual(providedBytes, expected)) fail()
  let payload
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
  } catch {
    fail()
  }
  const slot = slotAt(now)
  if (payload?.v !== 1 || payload.buyer !== readerHash(readerId, key) ||
      !UUID.test(String(payload.product_id || '')) || !UUID.test(String(payload.author_page_id || '')) ||
      !VALID_LANGUAGES.has(payload.language) || !VALID_PLACEMENTS.has(payload.placement) ||
      payload.rotation_key !== slot.rotationKey || payload.expires_at !== slot.expiresAt ||
      !Number.isSafeInteger(payload.issued_at) || payload.issued_at > Math.floor(now / 1000) + 30 ||
      payload.issued_at < Math.floor((slot.expiresAt - SLOT_MS) / 1000) ||
      !Number.isSafeInteger(payload.original_cents) || !Number.isSafeInteger(payload.author_cents) ||
      !Number.isSafeInteger(payload.promotion_cents) || payload.original_cents <= 0 ||
      payload.author_cents <= 0 || payload.promotion_cents !== payload.author_cents ||
      payload.author_cents > payload.original_cents ||
      payload.promotion_cents > Math.max(1, Math.floor(payload.original_cents * 0.8)) ||
      now >= payload.expires_at) fail()
  return payload
}

export function attachSmartPdfOfferTokens(selection, {
  readerId, placement, now = Date.now(), secret = process.env.JWT_SECRET,
} = {}) {
  if (!selection || selection.ok !== true || !Array.isArray(selection.promotions) ||
      selection.promotions.length > 3 || !VALID_PLACEMENTS.has(placement)) fail()
  const promotions = selection.promotions.map((offer) => ({
    ...offer,
    ...(readerId ? {
      smart_pdf_offer_token: issueSmartPdfOfferToken({
        ...offer,
        rotation_key: selection.rotation_key,
      }, { readerId, placement, now, secret }),
    } : {}),
  }))
  return { ...selection, promotions, promotion: promotions[0] || null }
}
