import test from 'node:test'
import assert from 'node:assert/strict'
import { BOOKING_TEXT_LIMITS, parseShadowPreOrderMessage } from '../../src/services/shadowAi/shadowAiPreOrderMessage.js'
import { assessShadowLocalConfidence as assess } from '../../src/services/shadowAi/local/shadowLocalConfidence.js'

const actorUserId = '11111111-1111-4111-8111-111111111111'
const bookId = '22222222-2222-4222-8222-222222222222'
const context = { books: [{ id: bookId, title: 'Moon', editions: [{ edition: 'standard' }] }], delivery_companies: [], signature_enabled: true, can_book: true, stock_verified: true }
const ready = { ready: true, missing: [], issues: [], pending_requirements: [] }
const blank = () => ({ intent: 'unclear', question: null, items: null, signature_requested: null, ...Object.fromEntries(Object.keys(BOOKING_TEXT_LIMITS).map(key => [key, null])) })
async function parse(data) {
  let calls = 0
  const parsed = await parseShadowPreOrderMessage({ actorUserId, message: 'test message', context, draft: {}, rules: [], runAi: async () => { calls++; return { data } } })
  assert.equal(calls, 1)
  return parsed
}

test('existing parser question contract is supported without another AI call', async () => {
  const parsed = await parse({ ...blank(), intent: 'question', question: 'stock' })
  assert.deepEqual(parsed, { intent: 'question', question: 'stock', patch: {} })
  const result = assess({ parsed, context, validation: ready })
  assert.equal(result.intent_score, 100)
  assert.equal(result.decision, 'inspect_question')
})
test('existing parser booking contract is supported without changing patch', async () => {
  const items = [{ book_id: bookId, edition: 'standard', quantity: 2 }]
  const parsed = await parse({ ...blank(), intent: 'booking', items })
  assert.deepEqual(parsed.patch, { items })
  const result = assess({ parsed, context, validation: { ...ready, ready: false, missing: ['name'] } })
  assert.equal(result.intent_score, 100)
  assert.equal(result.action_status, 'needs_information')
  assert.deepEqual(parsed.patch, { items })
})
test('existing parser suppresses patch on unclear output; confidence does not restore it', async () => {
  const parsed = await parse({ ...blank(), name: 'PRIVATE NAME' })
  assert.deepEqual(parsed.patch, {})
  const result = assess({ parsed, context, validation: ready })
  assert.equal(result.intent_score, 0)
  assert.equal(result.decision, 'clarify')
  assert.equal(result.action_status, 'not_requested')
})
test('existing parser still rejects invalid catalog selection', async () => {
  await assert.rejects(parse({ ...blank(), intent: 'booking', items: [{ book_id: 'other', edition: 'standard', quantity: 1 }] }), { code: 'SHADOW_AI_BOOKING_OUTPUT_INVALID' })
})
test('existing parser retains explicit false signature and clear semantics', async () => {
  const parsed = await parse({ ...blank(), intent: 'booking', signature_requested: false, buyer_note: '' })
  assert.deepEqual(parsed.patch, { buyer_note: '', signature_requested: false })
  assert.equal(assess({ parsed, context, validation: ready }).action_status, 'review_only')
})
