import test from 'node:test'
import assert from 'node:assert/strict'
import { guardShadowLocalTurn as guard } from './shadowLocalTurnGuard.js'

const id = '11111111-1111-4111-8111-111111111111'
const context = { can_book: true, stock_verified: true, signature_enabled: false, books: [{ id, editions: [{ edition: 'standard' }] }], delivery_companies: [{ company_key: 'carrier' }] }
const booking = patch => ({ intent: 'booking', question: null, patch })
const unclear = { intent: 'unclear', question: null, patch: {} }
const cases = [
  ['unknown field', booking({ payment: 'paid' })],
  ['wrong edition', booking({ items: [{ book_id: id, edition: 'limited', quantity: 1 }] })],
  ['wrong book', booking({ items: [{ book_id: 'other', edition: 'standard', quantity: 1 }] })],
  ['invalid quantity', booking({ items: [{ book_id: id, edition: 'standard', quantity: 100 }] })],
  ['disabled signature', booking({ signature_requested: true })],
  ['wrong carrier', booking({ delivery_company_key: 'other' })],
  ['question with patch', { intent: 'question', question: 'price', patch: { name: 'PRIVATE' } }],
  ['unrelated with patch', { intent: 'unrelated', question: null, patch: { name: 'PRIVATE' } }],
  ['malformed', null],
]
for (const [name, parsed] of cases) test(`${name} is corrected without exposing private data`, () => {
  const result = guard({ parsed, context })
  assert.deepEqual(result.parsed, unclear)
  assert.equal(result.corrected, true)
  assert.equal(result.reason, 'invalid_or_conflicting_output')
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|paid/)
})
test('empty booking and unknown question require clarification', () => {
  assert.deepEqual(guard({ parsed: booking({}), context }), { parsed: unclear, corrected: true, reason: 'booking_details_missing' })
  assert.deepEqual(guard({ parsed: { intent: 'question', question: null, patch: {} }, context }), { parsed: unclear, corrected: true, reason: 'question_category_missing' })
})
test('valid booking, question, unrelated and unclear remain unchanged', () => {
  for (const parsed of [booking({ name: 'Reader', signature_requested: false, buyer_note: '' }), booking({ items: [{ book_id: id, edition: 'standard', quantity: 1 }] }), { intent: 'question', question: 'price', patch: {} }, { intent: 'unrelated', question: null, patch: {} }, unclear]) {
    assert.deepEqual(guard({ parsed, context }), { parsed, corrected: false, reason: null })
  }
})
