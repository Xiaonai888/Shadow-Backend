import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createSmartPromotionOfferToken,
  verifySmartPromotionOfferToken,
  SmartPromotionOfferError,
} from '../services/smartPromotionOfferToken.service.js'

const secret = 'test-token-signing-secret-with-adequate-length'
const now = Date.parse('2026-11-23T04:00:00Z')
const storyId = '00000000-0000-4000-8000-000000000123'
const readerHash = 'a'.repeat(64)
const otherHash = 'b'.repeat(64)
const input = {
  readerHash,
  storyId,
  language: 'km',
  slotKey: '2026-11-23T06:00',
  expiresAt: '2026-11-23T05:00:00.000Z',
  price: 25,
  lockedCount: 5,
}

function issue() {
  return createSmartPromotionOfferToken(input, { now, secret })
}

function verify(token, changes = {}) {
  return verifySmartPromotionOfferToken(token, { readerHash, storyId, language: 'km', now, secret, ...changes })
}

test('a signed offer can only be used for its reader, story and language', () => {
  const token = issue()
  const verified = verify(token)
  assert.equal(verified.storyId, storyId)
  assert.equal(verified.readerHash, readerHash)
  assert.equal(verified.lockedCount, 5)
  assert.equal(verified.price, 25)
  assert.throws(() => verify(token, { readerHash: otherHash }), SmartPromotionOfferError)
  assert.throws(() => verify(token, { storyId: '00000000-0000-4000-8000-000000000124' }), SmartPromotionOfferError)
  assert.throws(() => verify(token, { language: 'en' }), SmartPromotionOfferError)
})

test('tampering with the offer invalidates the signature', () => {
  const token = issue()
  const parts = token.split('.')
  const offer = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
  offer.p = 1
  parts[1] = Buffer.from(JSON.stringify(offer)).toString('base64url')
  assert.throws(() => verify(parts.join('.')), SmartPromotionOfferError)
})

test('offers expire at the Cambodia six-hour rotation boundary', () => {
  const token = issue()
  assert.equal(verify(token, { now: Date.parse('2026-11-23T04:59:59Z') }).price, 25)
  assert.throws(() => verify(token, { now: Date.parse('2026-11-23T05:00:00Z') }), (error) =>
    error instanceof SmartPromotionOfferError && error.code === 'PROMOTION_EXPIRED')
})

test('cannot create an offer for another slot or with a bad price', () => {
  assert.throws(() => createSmartPromotionOfferToken({ ...input, slotKey: '2026-11-23T12:00' }, { now, secret }), SmartPromotionOfferError)
  assert.throws(() => createSmartPromotionOfferToken({ ...input, price: 0 }, { now, secret }), SmartPromotionOfferError)
  assert.throws(() => createSmartPromotionOfferToken({ ...input, price: 4 }, { now, secret }), SmartPromotionOfferError)
})

test('rejects malformed payload and missing secret', () => {
  assert.throws(() => verify('invalid.token'), SmartPromotionOfferError)
  assert.throws(() => verify('sp1.a.b'), SmartPromotionOfferError)
  const previous = process.env.JWT_SECRET
  process.env.JWT_SECRET = ''
  try {
    assert.throws(() => createSmartPromotionOfferToken(input, { now }), /secret/)
  } finally {
    if (previous === undefined) delete process.env.JWT_SECRET
    else process.env.JWT_SECRET = previous
  }
})
