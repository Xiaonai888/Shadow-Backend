import test from 'node:test'
import assert from 'node:assert/strict'
import { createShadowLocalPreOrderBridge } from './shadowLocalPreOrderBridge.js'
import { createShadowLocalDictionary } from './shadowLocalDictionary.js'
import { mergeShadowBookingDraft } from '../shadowAiPreOrderDraft.js'

const scope = { actorUserId: '11111111-1111-4111-8111-111111111111', authorPageId: '22222222-2222-4222-8222-222222222222', campaignId: '33333333-3333-4333-8333-333333333333', conversationId: '44444444-4444-4444-8444-444444444444' }
const context = { author_page_id: scope.authorPageId, campaign_id: scope.campaignId, can_book: true, stock_verified: true, books: [], delivery_companies: [], signature_enabled: false }
function fixture() {
  const bridge = createShadowLocalPreOrderBridge(), dictionary = createShadowLocalDictionary(), calls = []
  const input = { scope, revision: null, message: 'price', context, before: mergeShadowBookingDraft(context), rules: [], locale: 'en', runAi: async (request, meta) => { calls.push(meta); return { data: bridge.interpretReader(request.input, dictionary, meta) } } }
  return { bridge, input, calls }
}
test('passes only normalized scoped context to existing parser runtime', async () => {
  const f = fixture(), turn = await f.bridge.prepareTurn(f.input)
  assert.deepEqual(f.calls, [{ scope, revision: null }]); assert.equal(turn.question, 'price'); assert.equal(turn.reply.language, 'en'); assert.equal(turn.reply.kind, 'price')
  assert.equal(Object.hasOwn(turn, 'scope'), false); assert.equal(Object.hasOwn(turn, 'confidence'), false)
})
test('preparation alone does not commit memory or observation', async () => {
  const f = fixture(); await f.bridge.prepareTurn(f.input)
  assert.equal(f.bridge.learningSnapshot().counts.handled, 0)
  assert.equal((await f.bridge.prepareTurn({ ...f.input, message: 'repeat the last answer' })).intent, 'unclear')
})
test('requires authorization and original turn identity to commit', async () => {
  const f = fixture(), turn = await f.bridge.prepareTurn(f.input)
  for (const input of [{ scope, revision: null, turn }, { scope, revision: null, turn: { ...turn }, authorized: true }, { scope: { ...scope, conversationId: scope.actorUserId }, revision: null, turn, authorized: true }, { scope, revision: 1, turn, authorized: true }]) assert.equal(f.bridge.commitTurn(input), null)
  assert.equal(f.bridge.commitTurn({ scope, revision: null, turn, authorized: true }).reason, 'handled')
  assert.equal(f.bridge.commitTurn({ scope, revision: null, turn, authorized: true }), null)
  assert.equal(f.bridge.learningSnapshot().counts.handled, 1)
})
test('invalid scope and unavailable stock fail before parser call', async () => {
  const f = fixture()
  await assert.rejects(f.bridge.prepareTurn({ ...f.input, revision: -1 }), { code: 'SHADOW_AI_SESSION_INVALID' })
  await assert.rejects(f.bridge.prepareTurn({ ...f.input, scope: { ...scope, campaignId: scope.actorUserId } }), { code: 'SHADOW_AI_SESSION_INVALID' })
  await assert.rejects(f.bridge.prepareTurn({ ...f.input, context: { ...context, stock_verified: false } }), { code: 'SHADOW_AI_CAMPAIGN_UNAVAILABLE' })
  assert.equal(f.calls.length, 0)
})
test('booking commits only with newer saved revision', async () => {
  const f = fixture(), turn = await f.bridge.prepareTurn({ ...f.input, revision: 3, message: 'name: Example Reader' })
  assert.equal(turn.intent, 'booking'); assert.equal(turn.draft.name, 'Example Reader')
  assert.equal(f.bridge.commitTurn({ scope, revision: 3, turn, authorized: true }), null)
  assert.equal(f.bridge.commitTurn({ scope, revision: 4, turn, authorized: true }).reason, 'handled')
  assert.equal(JSON.stringify(f.bridge.learningSnapshot()).includes('Example Reader'), false)
})
