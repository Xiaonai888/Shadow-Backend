import test from 'node:test'
import assert from 'node:assert/strict'
import { decideShadowLocalReply as decide } from './shadowLocalReplyDecision.js'

const id = '11111111-1111-4111-8111-111111111111'
const context = { can_book: true, stock_verified: true, signature_enabled: true, books: [{ id, editions: [{ edition: 'standard' }] }], delivery_companies: [] }
const ready = { ready: true, missing: [], issues: [], pending_requirements: [] }
const booking = { intent: 'booking', question: null, patch: { name: 'PRIVATE' } }
const input = { parsed: booking, context, validation: ready }

for (const question of ['books','price','stock','delivery','signature','schedule','requirements']) {
  test(`verified ${question} routes to question context`, () => assert.deepEqual(decide({ ...input, parsed: { intent: 'question', question, patch: {} } }), { kind: question, question }))
}
test('unverified or unavailable context never requests a factual card', () => {
  for (const value of [null, { ...context, stock_verified: false }, { ...context, can_book: false }]) {
    assert.deepEqual(decide({ ...input, context: value, parsed: { intent: 'question', question: 'stock', patch: {} } }), { kind: 'unavailable', question: null })
  }
})
test('missing fields request only remaining information, pending-only does not promise readiness', () => {
  assert.equal(decide({ ...input, validation: { ...ready, ready: false, missing: ['phone_number'] } }).kind, 'missing')
  assert.equal(decide({ ...input, validation: { ...ready, ready: false, pending_requirements: ['buyer_note'] } }).kind, 'unavailable')
})
test('ready draft offers review only and missing validator fails closed', () => {
  assert.equal(decide(input).kind, 'review')
  assert.equal(decide({ ...input, validation: null }).kind, 'unavailable')
  assert.equal(decide({ ...input, validation: { ...ready, ready: false } }).kind, 'unavailable')
})
test('stock and signature issues select appropriate replies without exposing IDs', () => {
  for (const [issues, kind] of [[[`STOCK_UNAVAILABLE:${id}`], 'stock_issue'], [['SIGNATURE_UNAVAILABLE'], 'signature_issue'], [['STOCK_UNAVAILABLE','SIGNATURE_UNAVAILABLE'], 'unavailable'], [['STOCK_UNAVAILABLE','OTHER_ERROR'], 'unavailable'], [['PRIVATE'], 'unavailable']]) {
    const result = decide({ ...input, validation: { ...ready, ready: false, issues } })
    assert.deepEqual(result, { kind, question: null })
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE|11111111/)
  }
})
test('invalid patches and unknown intent cannot offer review', () => {
  for (const parsed of [{ intent: 'booking', question: null, patch: {} }, { intent: 'booking', question: null, patch: { payment: 'paid' } }, { intent: 'unclear', question: null, patch: {} }, { intent: 'question', question: 'unknown', patch: {} }]) assert.equal(decide({ ...input, parsed }).kind, 'clarify')
})
test('out of scope is separate from clarification', () => {
  assert.equal(decide({ ...input, parsed: { intent: 'unrelated', question: null, patch: {} } }).kind, 'out_of_scope')
})
