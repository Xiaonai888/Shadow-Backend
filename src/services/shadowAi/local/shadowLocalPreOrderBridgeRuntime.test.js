import test from 'node:test'
import assert from 'node:assert/strict'
import { createShadowLocalPreOrderBridge } from './shadowLocalPreOrderBridge.js'
import { createShadowLocalRuntime } from './shadowLocalRuntime.service.js'
import { createShadowLocalDictionary } from './shadowLocalDictionary.js'
import { mergeShadowBookingDraft } from '../shadowAiPreOrderDraft.js'

const scope = { actorUserId: '11111111-1111-4111-8111-111111111111', authorPageId: '22222222-2222-4222-8222-222222222222', campaignId: '33333333-3333-4333-8333-333333333333', conversationId: '44444444-4444-4444-8444-444444444444' }
const context = { author_page_id: scope.authorPageId, campaign_id: scope.campaignId, can_book: true, stock_verified: true, books: [], delivery_companies: [], signature_enabled: false }
function fixture({ deny = false, failFinish = false } = {}) {
  let time = 0
  const bridge = createShadowLocalPreOrderBridge({ now: () => time }), dictionary = createShadowLocalDictionary(), calls = []
  const runAi = createShadowLocalRuntime({ env: { SHADOW_AI_ENABLED: 'true' }, interpretReader: bridge.interpretReader, reserve: async () => { calls.push('reserve'); if (deny) throw Object.assign(new Error('Limit'), { code: 'SHADOW_AI_DAILY_LIMIT', statusCode: 429 }) }, finish: async () => { calls.push('finish'); if (failFinish) throw new Error('finish') }, knowledgeStore: { getDictionary: async () => { calls.push('dictionary'); return dictionary } } })
  const input = { scope, revision: null, message: 'price', context, before: mergeShadowBookingDraft(context), rules: [], runAi }
  return { bridge, input, calls, advance: ms => { time += ms } }
}
test('shared runtime reads memory only after successful authorized commit', async () => {
  const f = fixture(), turn = await f.bridge.prepareTurn(f.input)
  f.bridge.commitTurn({ scope, revision: null, turn, authorized: true })
  const next = await f.bridge.prepareTurn({ ...f.input, message: 'repeat the last answer' })
  assert.equal(next.question, 'price'); assert.equal(next.intent, 'question'); assert.deepEqual(f.calls, ['reserve', 'dictionary', 'finish', 'reserve', 'dictionary', 'finish'])
})
test('memory expires and cannot cross conversations or revisions', async () => {
  const f = fixture(), turn = await f.bridge.prepareTurn(f.input)
  f.bridge.commitTurn({ scope, revision: null, turn, authorized: true })
  const repeat = { ...f.input, message: 'repeat the last answer' }
  assert.equal((await f.bridge.prepareTurn({ ...repeat, scope: { ...scope, conversationId: scope.actorUserId } })).intent, 'unclear')
  f.advance(600000); assert.equal((await f.bridge.prepareTurn(repeat)).intent, 'unclear')
  const fresh = await f.bridge.prepareTurn(f.input); f.bridge.commitTurn({ scope, revision: null, turn: fresh, authorized: true })
  assert.equal((await f.bridge.prepareTurn({ ...repeat, revision: 1 })).intent, 'unclear')
})
test('reserve and finish failures cannot produce a prepared turn', async () => {
  const denied = fixture({ deny: true }); await assert.rejects(denied.bridge.prepareTurn(denied.input), { code: 'SHADOW_AI_DAILY_LIMIT' }); assert.deepEqual(denied.calls, ['reserve'])
  const failed = fixture({ failFinish: true }); await assert.rejects(failed.bridge.prepareTurn(failed.input), { code: 'SHADOW_AI_USAGE_UNAVAILABLE' }); assert.deepEqual(failed.calls, ['reserve', 'dictionary', 'finish']); assert.equal(failed.bridge.learningSnapshot().counts.handled, 0)
})
