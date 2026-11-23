import test from 'node:test'
import assert from 'node:assert/strict'
import {
  issueSmartPdfOfferToken, verifySmartPdfOfferToken, attachSmartPdfOfferTokens,
  SmartPdfOfferTokenError,
} from '../services/smartPdfOfferToken.service.js'

const secret = 'test-secret-for-smart-pdf-offers'
const readerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const otherReaderId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const now = Date.parse('2026-11-23T05:15:00.000Z')
const startsAt = Math.floor((now + 7 * 3600000) / (6 * 3600000)) * 6 * 3600000 - 7 * 3600000
const expiresAt = startsAt + 6 * 3600000
const offer = {
  product_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  author_page_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  product_type: 'pdf',
  story_language: 'km',
  original_price_usd: 10,
  author_price_usd: 8,
  promotion_price_usd: 8,
  discount_source: 'author',
  expires_at: new Date(expiresAt).toISOString(),
}
const options = { readerId, placement: 'stories', now, secret }
const issue = (item = offer, config = options) => issueSmartPdfOfferToken(item, config)
const verify = (token, config = { readerId, now, secret }) => verifySmartPdfOfferToken(token, config)
const invalid = (fn) => assert.throws(fn, SmartPdfOfferTokenError)

test('issues a valid offer and pins the buyer and the 6-hour slot', () => {
  const token = issue()
  const result = verify(token)
  assert.equal(result.product_id, offer.product_id)
  assert.equal(result.placement, 'stories')
  assert.equal(result.language, 'km')
  assert.equal(result.promotion_cents, 800)
  assert.equal(result.rotation_key, String(Math.floor(startsAt / 1000)))
  assert.equal(result.expires_at, expiresAt)
})

test('cannot redeem another reader offer', () => invalid(() => verify(issue(), { readerId: otherReaderId, now, secret })))
test('cannot redeem with a different secret', () => invalid(() => verify(issue(), { readerId, now, secret: 'different-key' })))
test('cannot redeem after slot expiry', () => invalid(() => verify(issue(), { readerId, now: expiresAt, secret })))
test('cannot redeem in a different rotation', () => invalid(() => verify(issue(), { readerId, now: expiresAt + 100, secret })))

test('rejects changed JSON payload', () => {
  const [encoded, mac] = issue().split('.')
  const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString())
  payload.promotion_cents = 100
  invalid(() => verify(`${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${mac}`))
})

test('rejects forged and malformed tokens', () => {
  invalid(() => verify('bad.token'))
  invalid(() => verify(''))
})

test('rejects an undiscounted PDF', () => invalid(() => issue({ ...offer, author_price_usd: 10, promotion_price_usd: 10 })))
test('rejects an altered promotion price', () => invalid(() => issue({ ...offer, promotion_price_usd: 1 })))
test('rejects a changed or unknown placement', () => invalid(() => issue(offer, { ...options, placement: 'freeUnlock' })))
test('rejects a mismatched or expired offer', () => invalid(() => issue({ ...offer, expires_at: new Date(expiresAt + 60000).toISOString() })))
test('rejects an offer with an invalid product type', () => invalid(() => issue({ ...offer, product_type: 'book' })))

test('attaches tokens for signed-in readers, not anonymous viewers', () => {
  const selection = { ok: true, rotation_key: String(Math.floor(startsAt / 1000)), promotions: [offer] }
  const signed = attachSmartPdfOfferTokens(selection, options)
  assert.equal(signed.promotions.length, 1)
  assert.equal(verify(signed.promotions[0].smart_pdf_offer_token).product_id, offer.product_id)
  const anonymous = attachSmartPdfOfferTokens(selection, { placement: 'stories', now, secret })
  assert.equal(anonymous.promotions[0].smart_pdf_offer_token, undefined)
})
