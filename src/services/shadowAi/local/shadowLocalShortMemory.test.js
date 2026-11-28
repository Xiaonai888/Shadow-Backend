import test from 'node:test'
import assert from 'node:assert/strict'
import { createShadowLocalShortMemory as create } from './shadowLocalShortMemory.js'

const scope = { actorUserId: '11111111-1111-4111-8111-111111111111', authorPageId: '22222222-2222-4222-8222-222222222222', campaignId: '33333333-3333-4333-8333-333333333333', conversationId: '44444444-4444-4444-8444-444444444444' }
const other = '55555555-5555-4555-8555-555555555555'
const turn = { scope, revision: 1, intent: 'question', question: 'price' }
test('retains only category, not private text, catalog, or draft', () => {
  const m = create(); assert.equal(m.remember({ ...turn, message: 'PRIVATE', draft: { phone: '012345678' }, price: 99 }), true)
  assert.deepEqual(m.read(turn), { question: 'price' })
  const copy = m.read(turn); copy.question = 'stock'; assert.deepEqual(m.read(turn), { question: 'price' })
})
test('each scope dimension is isolated', () => {
  const m = create(); m.remember(turn)
  for (const field of Object.keys(scope)) assert.equal(m.read({ ...turn, scope: { ...scope, [field]: other } }), null)
  assert.deepEqual(m.read(turn), { question: 'price' })
})
test('revision change invalidates context', () => {
  const m = create(); m.remember(turn); assert.equal(m.read({ ...turn, revision: 2 }), null); assert.equal(m.read(turn), null)
})
test('null revision supports authorized unsaved sessions', () => {
  const m = create(); m.remember({ ...turn, revision: null }); assert.deepEqual(m.read({ ...turn, revision: null }), { question: 'price' })
})
test('read does not extend ten minute TTL', () => {
  let time = 0; const m = create({ now: () => time }); m.remember(turn); time = 599999; assert.ok(m.read(turn)); time = 600000; assert.equal(m.read(turn), null); assert.equal(m.size(), 0)
})
test('non-question turn clears previous category', () => {
  const m = create(); for (const intent of ['booking', 'unclear', 'unrelated']) { m.remember(turn); assert.equal(m.remember({ ...turn, intent }), false); assert.equal(m.read(turn), null) }
})
test('capacity is bounded and evicts oldest record', () => {
  const m = create({ maxEntries: 1 }); m.remember(turn); const next = { ...turn, scope: { ...scope, conversationId: other } }; m.remember(next); assert.equal(m.size(), 1); assert.equal(m.read(turn), null); assert.ok(m.read(next))
})
test('invalid scope revision or category cannot become memory', () => {
  const m = create(); for (const input of [{ ...turn, scope: {} }, { ...turn, revision: -1 }, { ...turn, question: 'PRIVATE' }]) assert.equal(m.remember(input), false)
  assert.equal(m.size(), 0); assert.equal(m.clear({}), false)
})
