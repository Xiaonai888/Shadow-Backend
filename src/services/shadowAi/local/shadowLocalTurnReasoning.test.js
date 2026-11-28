import test from 'node:test'
import assert from 'node:assert/strict'
import { createShadowLocalTurnReasoning as create } from './shadowLocalTurnReasoning.js'

const id = '11111111-1111-4111-8111-111111111111'
const context = { can_book: true, stock_verified: true, signature_enabled: true, books: [{ id, editions: [{ edition: 'standard' }] }], delivery_companies: [] }
const before = Object.freeze({ name: 'Original', items: [] })
const rules = Object.freeze([])
const ready = { ready: true, missing: [], issues: [], pending_requirements: [] }
const booking = patch => ({ intent: 'booking', question: null, patch })
function fixture(validation = ready) {
  const calls = []
  const run = create({ mergeDraft(c, previous, patch) { calls.push(['merge', c, previous, patch]); return { ...previous, ...patch } }, inspectDraft(c, draft, r) { calls.push(['inspect', c, draft, r]); return validation } })
  return { calls, run: (parsed, overrides = {}) => run({ parsed, context, before, rules, ...overrides }) }
}
test('corrected patch never reaches draft merger', () => {
  const f = fixture()
  const result = f.run(booking({ payment: 'paid' }))
  assert.deepEqual(f.calls[0], ['merge', context, before, {}])
  assert.deepEqual(result.draft, before)
  assert.equal(result.parsed.intent, 'unclear')
  assert.equal(result.confidence.decision, 'clarify')
  assert.equal(result.correction.applied, true)
  assert.equal(f.calls.length, 2)
})
test('valid patch uses existing merger and validation once', () => {
  const f = fixture()
  const result = f.run(booking({ name: 'Updated' }))
  assert.equal(result.draft.name, 'Updated')
  assert.equal(before.name, 'Original')
  assert.equal(result.confidence.decision, 'offer_review')
  assert.deepEqual(result.correction, { applied: false, reason: null })
  assert.deepEqual(f.calls.map(x => x[0]), ['merge', 'inspect'])
  assert.equal(f.calls[1][3], rules)
})
test('missing details remain missing and no review is authorized', () => {
  const validation = { ...ready, ready: false, missing: ['phone_number'] }
  const result = fixture(validation).run(booking({ name: 'Updated' }))
  assert.equal(result.validation, validation)
  assert.equal(result.confidence.decision, 'ask_missing_details')
})
test('real stock issue is not silently corrected or discarded', () => {
  const validation = { ...ready, ready: false, issues: [`STOCK_UNAVAILABLE:${id}`] }
  const items = [{ book_id: id, edition: 'standard', quantity: 9 }]
  const result = fixture(validation).run(booking({ items }))
  assert.deepEqual(result.draft.items, items)
  assert.equal(result.confidence.action_status, 'blocked')
  assert.equal(result.correction.applied, false)
})
test('unverified campaign fails before merge', () => {
  const f = fixture()
  assert.throws(() => f.run(booking({ name: 'Updated' }), { context: { ...context, stock_verified: false } }), { code: 'SHADOW_AI_CAMPAIGN_UNAVAILABLE' })
  assert.equal(f.calls.length, 0)
})
test('malformed or contradictory validator result is rejected', () => {
  for (const validation of [null, { ready: true }, { ...ready, missing: ['name'] }, { ...ready, issues: ['STOCK_UNAVAILABLE'] }, { ...ready, pending_requirements: ['buyer_note'] }]) {
    assert.throws(() => fixture(validation).run(booking({ name: 'Updated' })), { code: 'SHADOW_AI_SESSION_INVALID' })
  }
})
test('questions never gain an action even with a ready draft', () => {
  const result = fixture().run({ intent: 'question', question: 'price', patch: {} })
  assert.equal(result.confidence.action_status, 'not_requested')
  assert.equal(result.confidence.decision, 'inspect_question')
})
