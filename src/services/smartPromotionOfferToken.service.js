import { createHmac, timingSafeEqual } from 'node:crypto'
import { smartAdCambodiaSlot } from './smartAdEligibility.service.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const HASH = /^[0-9a-f]{64}$/
const SLOT = /^\d{4}-\d{2}-\d{2}T(?:00|06|12|18):00$/
const LANGUAGES = new Set(['km', 'en', 'zh', 'ja', 'ko'])
const TOKEN_PREFIX = 'sp1'
const MAX_TOKEN_LENGTH = 1600

export class SmartPromotionOfferError extends Error {
  constructor(message, code = 'PROMOTION_CHANGED', status = 409, details = {}) {
    super(message)
    this.name = 'SmartPromotionOfferError'
    this.code = code
    this.status = status
    this.details = details
  }
}

function signingKey(secret) {
  const value = String(secret || process.env.JWT_SECRET || '')
  if (value.length < 16) throw new Error('Smart Promotion signing secret is unavailable')
  return createHmac('sha256', value).update('shadow-smart-promotion-offer:v1').digest()
}

function sign(payload, key) {
  return createHmac('sha256', key).update(`${TOKEN_PREFIX}.${payload}`).digest('base64url')
}

function validCount(value, min = 1) {
  return Number.isSafeInteger(value) && value >= min && value <= 1000000
}

function cleanOfferFields(input) {
  const readerHash = String(input?.readerHash || '').trim().toLowerCase()
  const storyId = String(input?.storyId || '').trim().toLowerCase()
  const language = String(input?.language || '').trim().toLowerCase()
  const slotKey = String(input?.slotKey || '').trim()
  const expiresAt = Date.parse(String(input?.expiresAt || ''))
  const price = Number(input?.price)
  const lockedCount = Number(input?.lockedCount)
  if (!HASH.test(readerHash) || !UUID.test(storyId) || !LANGUAGES.has(language) ||
      !SLOT.test(slotKey) || !Number.isFinite(expiresAt) ||
      !validCount(price) || !validCount(lockedCount) || price < lockedCount) {
    throw new SmartPromotionOfferError('Invalid Special Promotion offer', 'PROMOTION_CHANGED')
  }
  return { readerHash, storyId, language, slotKey, expiresAt, price, lockedCount }
}

export function createSmartPromotionOfferToken(input, { secret, now = Date.now() } = {}) {
  const offer = cleanOfferFields(input)
  const slot = smartAdCambodiaSlot(now)
  if (offer.slotKey !== slot.slot_key || offer.expiresAt !== Date.parse(slot.next_rotation_at) ||
      now >= offer.expiresAt) {
    throw new SmartPromotionOfferError('The Special Promotion has expired', 'PROMOTION_EXPIRED')
  }
  const payload = Buffer.from(JSON.stringify({
    v: 1,
    r: offer.readerHash,
    s: offer.storyId,
    l: offer.language,
    k: offer.slotKey,
    e: offer.expiresAt,
    p: offer.price,
    c: offer.lockedCount,
  })).toString('base64url')
  return `${TOKEN_PREFIX}.${payload}.${sign(payload, signingKey(secret))}`
}

export function verifySmartPromotionOfferToken(token, {
  readerHash,
  storyId,
  language,
  secret,
  now = Date.now(),
} = {}) {
  if (typeof token !== 'string' || token.length > MAX_TOKEN_LENGTH || token.length < 30) {
    throw new SmartPromotionOfferError('Missing or invalid Special Promotion offer', 'PROMOTION_CHANGED')
  }
  const parts = token.split('.')
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX || !/^[A-Za-z0-9_-]+$/.test(parts[1]) ||
      !/^[A-Za-z0-9_-]{43}$/.test(parts[2])) {
    throw new SmartPromotionOfferError('Invalid Special Promotion offer', 'PROMOTION_CHANGED')
  }
  const expected = sign(parts[1], signingKey(secret))
  if (!timingSafeEqual(Buffer.from(parts[2]), Buffer.from(expected))) {
    throw new SmartPromotionOfferError('Invalid Special Promotion signature', 'PROMOTION_CHANGED')
  }
  let data
  try {
    data = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
  } catch {
    throw new SmartPromotionOfferError('Invalid Special Promotion data', 'PROMOTION_CHANGED')
  }
  if (data?.v !== 1) throw new SmartPromotionOfferError('Unsupported Special Promotion offer', 'PROMOTION_CHANGED')
  if (!Number.isSafeInteger(data.e)) {
    throw new SmartPromotionOfferError('Invalid Special Promotion expiry', 'PROMOTION_CHANGED')
  }
  const offer = cleanOfferFields({
    readerHash: data.r,
    storyId: data.s,
    language: data.l,
    slotKey: data.k,
    expiresAt: new Date(data.e).toISOString(),
    price: data.p,
    lockedCount: data.c,
  })
  if (offer.readerHash !== String(readerHash || '').toLowerCase() ||
      offer.storyId !== String(storyId || '').toLowerCase() ||
      (language && offer.language !== String(language).toLowerCase())) {
    throw new SmartPromotionOfferError('Special Promotion belongs to another reader or story', 'PROMOTION_CHANGED')
  }
  const slot = smartAdCambodiaSlot(now)
  if (offer.slotKey !== slot.slot_key || offer.expiresAt !== Date.parse(slot.next_rotation_at) ||
      now >= offer.expiresAt) {
    throw new SmartPromotionOfferError('The Special Promotion has expired', 'PROMOTION_EXPIRED')
  }
  return offer
}
