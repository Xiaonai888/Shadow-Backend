import test from 'node:test'
import assert from 'node:assert/strict'
import { BOOKING_TEXT_LIMITS, parseShadowPreOrderMessage } from '../shadowAiPreOrderMessage.js'
import { createShadowLocalTurnReasoning } from './shadowLocalTurnReasoning.js'
import { composeShadowLocalReply } from './shadowLocalReplyComposer.js'

const actorUserId = '11111111-1111-4111-8111-111111111111', id = '22222222-2222-4222-8222-222222222222'
const context = { can_book: true, stock_verified: true, signature_enabled: false, books: [{ id, title: 'Moon', editions: [{ edition: 'standard', available: 3 }] }], delivery_companies: [] }
const before = { items: [], name: 'Reader' }, rules = []
const ready = { ready: true, missing: [], issues: [], pending_requirements: [] }
const blank = () => ({ intent: 'unclear', question: null, items: null, signature_requested: null, ...Object.fromEntries(Object.keys(BOOKING_TEXT_LIMITS).map(key => [key, null])) })
async function turn(data, validation = ready) {
  let calls = 0
  const parsed = await parseShadowPreOrderMessage({ actorUserId, message: 'test', context, draft: before, rules, runAi: async () => { calls++; return { data } } })
  const reason = createShadowLocalTurnReasoning({ mergeDraft: (c, draft, patch) => ({ ...draft, ...patch }), inspectDraft: () => validation })
  const result = reason({ parsed, context, before, rules })
  const reply = composeShadowLocalReply({ parsed: result.parsed, context, validation: result.validation, locale: 'km' })
  assert.equal(calls, 1)
  return { result, reply }
}
test('unsupported edition that passes existing parser is removed before merge', async () => {
  const { result, reply } = await turn({ ...blank(), intent: 'booking', items: [{ book_id: id, edition: 'limited', quantity: 1 }] })
  assert.equal(result.correction.applied, true)
  assert.deepEqual(result.draft, before)
  assert.equal(reply.kind, 'clarify')
})
test('valid question keeps existing reply category', async () => {
  const { result, reply } = await turn({ ...blank(), intent: 'question', question: 'price' })
  assert.equal(result.parsed.question, 'price')
  assert.equal(result.correction.applied, false)
  assert.equal(reply.kind, 'price')
})
test('valid booking with missing fields uses existing missing reply', async () => {
  const { result, reply } = await turn({ ...blank(), intent: 'booking', name: 'Updated' }, { ...ready, ready: false, missing: ['phone_number'] })
  assert.equal(result.draft.name, 'Updated')
  assert.equal(reply.kind, 'missing')
})
test('stock validation still blocks review without altering quantity', async () => {
  const { result, reply } = await turn({ ...blank(), intent: 'booking', items: [{ book_id: id, edition: 'standard', quantity: 4 }] }, { ...ready, ready: false, issues: [`STOCK_UNAVAILABLE:${id}`] })
  assert.equal(result.draft.items[0].quantity, 4)
  assert.equal(result.confidence.action_status, 'blocked')
  assert.equal(reply.kind, 'stock_issue')
})
test('existing parser rejects invalid IDs before reasoning', async () => {
  await assert.rejects(turn({ ...blank(), intent: 'booking', items: [{ book_id: 'other', edition: 'standard', quantity: 1 }] }), { code: 'SHADOW_AI_BOOKING_OUTPUT_INVALID' })
})
