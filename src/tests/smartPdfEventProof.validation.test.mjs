import test from 'node:test'
import assert from 'node:assert/strict'
import {
  issueSmartPdfEventProof,
  verifySmartPdfEventProof,
  attachSmartPdfEventProofs,
  SmartPdfEventProofError,
} from '../services/smartPdfEventProof.service.js'

const readerHash = 'a'.repeat(64)
const productId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const otherProduct = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const secret = 'smart-pdf-event-test-signing-secret'
const now = Date.parse('2026-11-23T06:30:00.000Z')
const offset = 7 * 3600000
const slot = 6 * 3600000
const start = Math.floor((now + offset) / slot) * slot - offset
const expiresAt = start + slot
const rotationKey = String(start / 1000)
const issueArgs = { readerHash, productId, placement: 'stories', rotationKey, now, secret }
const issue = (patch = {}) => issueSmartPdfEventProof({ ...issueArgs, ...patch })
const verify = (proof, patch = {}) => verifySmartPdfEventProof(proof, { ...issueArgs, ...patch })
const invalid = (fn) => assert.throws(fn, SmartPdfEventProofError)

test('valid proof binds reader, product, placement and slot', () => {
  const claims = verify(issue())
  assert.equal(claims.reader, readerHash)
  assert.equal(claims.product_id, productId)
  assert.equal(claims.placement, 'stories')
  assert.equal(claims.rotation_key, rotationKey)
})

test('rejects changed reader', () => invalid(() => verify(issue(), { readerHash: 'b'.repeat(64) })))
test('rejects changed product', () => invalid(() => verify(issue(), { productId: otherProduct })))
test('rejects changed placement', () => invalid(() => verify(issue(), { placement: 'discover' })))
test('rejects changed slot', () => invalid(() => verify(issue(), { rotationKey: String((start - slot) / 1000) })))
test('rejects changed secret', () => invalid(() => verify(issue(), { secret: 'wrong-secret' })))
test('rejects malformed proof', () => invalid(() => verify('bogus.token')))
test('rejects absent proof', () => invalid(() => verify('')))
test('accepts delayed tracking within five minutes of slot expiry', () => {
  assert.equal(verify(issue(), { now: expiresAt + 299999 }).product_id, productId)
})
test('rejects tracking at five-minute grace limit', () => invalid(() => verify(issue(), { now: expiresAt + 300000 })))
test('rejects proof issued outside its slot', () => invalid(() => issue({ now: expiresAt })))
test('rejects unaligned rotation keys', () => invalid(() => issue({ rotationKey: String(start / 1000 + 1) })))
test('rejects tampered payload', () => {
  const [encoded, mac] = issue().split('.')
  const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString())
  payload.product_id = otherProduct
  invalid(() => verify(`${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${mac}`))
})
test('attaches proof to each selected offer for anonymous readers', () => {
  const selection = {
    ok: true,
    rotation_key: rotationKey,
    promotions: [{ product_id: productId }, { product_id: otherProduct }],
  }
  const signed = attachSmartPdfEventProofs(selection, { readerHash, placement: 'stories', now, secret })
  assert.equal(signed.promotions.length, 2)
  for (const offer of signed.promotions) {
    assert.equal(verify(offer.smart_pdf_event_proof, { productId: offer.product_id }).product_id, offer.product_id)
  }
})
