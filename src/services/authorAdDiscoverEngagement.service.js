import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SIGNATURE = /^[a-f0-9]{64}$/
const ENCODED = /^[A-Za-z0-9_-]+$/
const TOKEN_TTL_SECONDS = 600
const IMPRESSION_AGE_SECONDS = 120
const MAX_TOKEN_LENGTH = 1024
const MAX_RECEIPT_BYTES = 512
const CLOCK_SKEW_SECONDS = 5
const EVENT_TYPES = new Set(['impression', 'click'])

function requireId(value, name) {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new TypeError('Invalid ' + name)
  }
  return value.toLowerCase()
}

function signingSecret() {
  const value = process.env.AUTHOR_AD_DISCOVER_RECEIPT_SECRET || process.env.JWT_SECRET
  if (typeof value !== 'string' || value.length < 16) {
    throw new Error('Author ad receipt signing is not configured')
  }
  return value
}

function assertEnabled() {
  if (process.env.AUTHOR_ADS_DELIVERY_ENABLED !== 'true') {
    const error = new Error('Author ad delivery is disabled')
    error.code = 'AUTHOR_ADS_DELIVERY_DISABLED'
    throw error
  }
}

function sign(data) {
  return createHmac('sha256', signingSecret())
    .update('shadow-author-ads-discover-v1:')
    .update(data)
    .digest('hex')
}

function encodedReceipt(data) {
  return Buffer.from(JSON.stringify(data), 'utf8').toString('base64url')
}

export function issueAuthorAdDiscoverReceipt(candidate, viewerUserId) {
  assertEnabled()
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new TypeError('Invalid Discover Boost candidate')
  }

  const issuedAt = Math.floor(Date.now() / 1000)
  const receipt = {
    v: 1,
    c: requireId(candidate.campaignId, 'campaign ID'),
    p: requireId(candidate.postId, 'post ID'),
    a: requireId(candidate.authorPageId, 'author page ID'),
    u: requireId(viewerUserId, 'viewer ID'),
    iat: issuedAt,
    exp: issuedAt + TOKEN_TTL_SECONDS,
    n: randomUUID(),
  }

  const encoded = encodedReceipt(receipt)
  if (Buffer.byteLength(encoded, 'utf8') > MAX_RECEIPT_BYTES * 2) {
    throw new Error('Author ad receipt is too large')
  }
  return encoded + '.' + sign(encoded)
}

export function verifyAuthorAdDiscoverReceipt({
  token,
  viewerUserId,
  postId,
  eventType,
} = {}) {
  assertEnabled()

  const expectedViewerId = requireId(viewerUserId, 'viewer ID')
  const expectedPostId = requireId(postId, 'post ID')
  if (!EVENT_TYPES.has(eventType)) {
    throw new TypeError('Invalid Discover Boost event type')
  }
  if (typeof token !== 'string' || token.length > MAX_TOKEN_LENGTH) {
    throw new TypeError('Invalid Discover Boost receipt')
  }

  const parts = token.split('.')
  if (parts.length !== 2 || !ENCODED.test(parts[0]) || !SIGNATURE.test(parts[1])) {
    throw new TypeError('Invalid Discover Boost receipt')
  }

  const encoded = parts[0]
  const decoded = Buffer.from(encoded, 'base64url')
  if (
    !decoded.length ||
    decoded.length > MAX_RECEIPT_BYTES ||
    decoded.toString('base64url') !== encoded
  ) {
    throw new TypeError('Invalid Discover Boost receipt')
  }

  const suppliedSignature = Buffer.from(parts[1], 'hex')
  const expectedSignature = Buffer.from(sign(encoded), 'hex')
  if (!timingSafeEqual(suppliedSignature, expectedSignature)) {
    throw new TypeError('Discover Boost receipt signature failed')
  }

  let receipt
  try {
    receipt = JSON.parse(decoded.toString('utf8'))
  } catch {
    throw new TypeError('Invalid Discover Boost receipt payload')
  }

  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    throw new TypeError('Invalid Discover Boost receipt payload')
  }

  const campaignId = requireId(receipt.c, 'receipt campaign ID')
  const receiptPostId = requireId(receipt.p, 'receipt post ID')
  const authorPageId = requireId(receipt.a, 'receipt author page ID')
  const receiptViewerId = requireId(receipt.u, 'receipt viewer ID')
  const verifiedActionId = requireId(receipt.n, 'receipt action ID')
  const now = Math.floor(Date.now() / 1000)
  const age = now - receipt.iat
  const allowedAge = eventType === 'impression'
    ? IMPRESSION_AGE_SECONDS
    : TOKEN_TTL_SECONDS

  if (
    receipt.v !== 1 ||
    !Number.isSafeInteger(receipt.iat) ||
    !Number.isSafeInteger(receipt.exp) ||
    receipt.exp - receipt.iat !== TOKEN_TTL_SECONDS ||
    age < -CLOCK_SKEW_SECONDS ||
    age > allowedAge ||
    now > receipt.exp ||
    receiptViewerId !== expectedViewerId ||
    receiptPostId !== expectedPostId
  ) {
    throw new TypeError('Discover Boost receipt expired or does not match')
  }

  return Object.freeze({
    campaignId,
    postId: receiptPostId,
    authorPageId,
    viewerUserId: receiptViewerId,
    verifiedActionId,
    eventType,
    placement: 'discover',
  })
}
