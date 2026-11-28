import test from 'node:test'
import assert from 'node:assert/strict'
import { createShadowLocalBrain } from './shadowLocalBrain.service.js'
import { createShadowLocalDictionary } from './shadowLocalDictionary.js'
import { BOOKING_TEXT_LIMITS, parseShadowPreOrderMessage } from '../shadowAiPreOrderMessage.js'

const scope = { actorUserId: '11111111-1111-4111-8111-111111111111', authorPageId: '22222222-2222-4222-8222-222222222222', campaignId: '33333333-3333-4333-8333-333333333333', conversationId: '44444444-4444-4444-8444-444444444444' }
const context = { author_page_id: scope.authorPageId, campaign_id: scope.campaignId, can_book: true, stock_verified: true, books: [], delivery_companies: [], signature_enabled: false }
const dictionary = createShadowLocalDictionary()
const blank = () => ({ intent: 'unclear', question: null, items: null, signature_requested: null, ...Object.fromEntries(Object.keys(BOOKING_TEXT_LIMITS).map(key => [key, null])) })
function fixture() {
  let runtimeCalls = 0, interpreterCalls = 0
  const brain = createShadowLocalBrain({ interpretReader(input, dict) { interpreterCalls++; const question = dict.lookup('questions', input.message); return question ? { ...blank(), intent: 'question', question } : blank() }, mergeDraft: (_, before, patch) => ({ ...before, ...patch }), inspectDraft: () => ({ ready: false, missing: ['name'], issues: [], pending_requirements: [] }) })
  return { brain, counts: () => [runtimeCalls, interpreterCalls], async prepare(message) {
    const parsed = await parseShadowPreOrderMessage({ actorUserId: scope.actorUserId, message, context, draft: {}, rules: [], runAi: async ({ input }) => { runtimeCalls++; return { data: brain.interpretReader(input, dictionary, { scope, revision: null }) } } })
    return brain.reasonTurn({ scope, revision: null, parsed, context, before: {}, rules: [], locale: 'km' })
  } }
}
test('existing parser contract supports shared brain and memory without extra runtime calls', async () => { const f = fixture(); const first = await f.prepare('price'); f.brain.commitTurn({ scope, revision: null, turn: first }); const second = await f.prepare('repeat the last answer'); assert.deepEqual(second.parsed, { intent: 'question', question: 'price', patch: {} }); assert.equal(second.reply.kind, 'price'); assert.deepEqual(f.counts(), [2, 3]) })
test('unknown user text creates only categorical observation after explicit commit', async () => { const f = fixture(); const turn = await f.prepare('private sample message'); assert.equal(turn.parsed.intent, 'unclear'); assert.equal(f.brain.learningSnapshot().counts.unknown_intent, 0); f.brain.commitTurn({ scope, revision: null, turn }); const snapshot = f.brain.learningSnapshot(); assert.equal(snapshot.counts.unknown_intent, 1); assert.equal(JSON.stringify(snapshot).includes('private sample message'), false); assert.deepEqual(f.counts(), [1, 1]) })
test('uncommitted turn cannot affect subsequent memory', async () => { const f = fixture(); await f.prepare('price'); const next = await f.prepare('repeat the last answer'); assert.equal(next.parsed.intent, 'unclear'); assert.deepEqual(f.counts(), [2, 2]) })
