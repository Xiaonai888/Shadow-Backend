import test from 'node:test'
import assert from 'node:assert/strict'
import { assessShadowLocalConfidence as assess } from '../../src/services/shadowAi/local/shadowLocalConfidence.js'

const id = '11111111-1111-4111-8111-111111111111'
const context = { stock_verified: true, can_book: true, books: [{ id, editions: [{ edition: 'standard' }] }], delivery_companies: [{ company_key: 'carrier' }], signature_enabled: true }
const ready = { ready: true, missing: [], issues: [], pending_requirements: [] }
const booking = patch => ({ intent: 'booking', question: null, patch })
const question = key => ({ intent: 'question', question: key, patch: {} })

test('known question has rule evidence but no action and is not a verified answer', () => {
  const result = assess({ parsed: question('price'), context, validation: ready })
  assert.equal(result.intent_score, 100)
  assert.equal(result.score_kind, 'rule_evidence_not_accuracy_probability')
  assert.equal(result.knowledge_status, 'verified_context')
  assert.equal(result.decision, 'inspect_question')
  assert.equal(result.action_status, 'not_requested')
})
test('question category missing is partial evidence and asks for clarification', () => {
  for (const key of [null, 'unknown']) {
    const result = assess({ parsed: question(key), context })
    assert.equal(result.intent_score, 50)
    assert.equal(result.decision, 'clarify')
  }
})
test('unclear and outside scope are not confident booking actions', () => {
  for (const intent of ['unclear', 'unrelated']) {
    const result = assess({ parsed: { intent, question: null, patch: {} }, context, validation: ready })
    assert.equal(result.intent_score, 0)
    assert.equal(result.action_status, 'not_requested')
    assert.equal(result.decision, intent === 'unclear' ? 'clarify' : 'out_of_scope')
  }
})
test('valid explicit booking fields are recognized, even false and empty clear', () => {
  for (const patch of [{ name: 'Reader' }, { signature_requested: false }, { buyer_note: '' }, { items: [{ book_id: id, edition: 'standard', quantity: 1 }] }]) {
    const result = assess({ parsed: booking(patch), context, validation: ready })
    assert.equal(result.intent_score, 100)
    assert.equal(result.action_status, 'review_only')
    assert.equal(result.decision, 'offer_review')
    assert.ok(!('patch' in result))
  }
})
test('empty booking patch cannot offer review even when draft is ready', () => {
  const result = assess({ parsed: booking({}), context, validation: ready })
  assert.equal(result.intent_score, 50)
  assert.equal(result.action_status, 'not_requested')
  assert.equal(result.decision, 'clarify')
})
test('invalid patch or conflicting intent is not accepted', () => {
  const invalid = [booking({ payment: 'paid' }), booking({ items: [{ book_id: 'other', edition: 'standard', quantity: 1 }] }), booking({ items: [{ book_id: id, edition: 'limited', quantity: 1 }] }), booking({ items: [{ book_id: id, edition: 'standard', quantity: 0 }] }), booking({ delivery_company_key: 'other' }), booking({ signature_requested: 'yes' }), booking({ name: 1 }), { ...question('price'), patch: { name: 'Reader' } }, { intent: 'unrelated', question: null, patch: { name: 'Reader' } }]
  for (const parsed of invalid) {
    const result = assess({ parsed, context, validation: ready })
    assert.equal(result.intent_score, 0)
    assert.equal(result.decision, 'clarify')
    assert.equal(result.action_status, 'not_requested')
  }
})
test('missing fields or pending requirements prevent review', () => {
  for (const validation of [{ ...ready, missing: ['phone_number'] }, { ...ready, pending_requirements: ['buyer_note'] }]) {
    const result = assess({ parsed: booking({ name: 'Reader' }), context, validation })
    assert.equal(result.intent_score, 100)
    assert.equal(result.action_status, 'needs_information')
    assert.equal(result.decision, 'ask_missing_details')
  }
})
test('stock issue or unverified campaign blocks review despite strong intent evidence', () => {
  const parsed = booking({ name: 'Reader' })
  for (const input of [{ context, validation: { ...ready, issues: ['STOCK_UNAVAILABLE'] } }, { context: { ...context, stock_verified: false }, validation: ready }, { context: { ...context, can_book: false }, validation: ready }, { context: null, validation: ready }]) {
    const result = assess({ parsed, ...input })
    assert.equal(result.intent_score, 100)
    assert.equal(result.action_status, 'blocked')
    assert.equal(result.decision, 'unavailable')
  }
})
test('missing or inconsistent validator output cannot authorize review', () => {
  for (const validation of [null, { ready: true }, { ...ready, ready: false }, { ...ready, issues: null }]) {
    const result = assess({ parsed: booking({ name: 'Reader' }), context, validation })
    assert.equal(result.action_status, 'unverified')
    assert.equal(result.decision, 'unavailable')
  }
})
test('unverified knowledge does not permit a question answer path', () => {
  for (const value of [null, { ...context, stock_verified: false }, { ...context, can_book: false }]) {
    const result = assess({ parsed: question('stock'), context: value })
    assert.equal(result.intent_score, 100)
    assert.equal(result.decision, 'unavailable')
  }
})
test('no raw private text or draft modification and no external dependency', () => {
  const parsed = Object.freeze(booking(Object.freeze({ name: 'PRIVATE NAME', phone_number: '012345678' })))
  const before = JSON.stringify(parsed)
  const result = assess({ parsed, context, validation: ready })
  assert.equal(JSON.stringify(parsed), before)
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE NAME|012345678/)
  assert.equal(assess().intent_score, 0)
})
