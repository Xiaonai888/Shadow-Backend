import test from 'node:test'
import assert from 'node:assert/strict'
import { createShadowLocalBrain } from './shadowLocalBrain.service.js'
import { createShadowLocalDictionary } from './shadowLocalDictionary.js'
import { BOOKING_TEXT_LIMITS } from '../shadowAiPreOrderMessage.js'

const scope = { actorUserId: '11111111-1111-4111-8111-111111111111', authorPageId: '22222222-2222-4222-8222-222222222222', campaignId: '33333333-3333-4333-8333-333333333333', conversationId: '44444444-4444-4444-8444-444444444444' }
const context = { author_page_id: scope.authorPageId, campaign_id: scope.campaignId, can_book: true, stock_verified: true, books: [], delivery_companies: [], signature_enabled: false }
const dictionary = createShadowLocalDictionary()
const blank = () => ({ intent: 'unclear', question: null, items: null, signature_requested: null, ...Object.fromEntries(Object.keys(BOOKING_TEXT_LIMITS).map(key => [key, null])) })
const price = { intent: 'question', question: 'price', patch: {} }
function fixture() {
  let time = 0
  const brain = createShadowLocalBrain({ now: () => time, interpretReader(input, dict) { const question = dict.lookup('questions', input.message); return question ? { ...blank(), intent: 'question', question } : blank() }, mergeDraft: (_, before, patch) => ({ ...before, ...patch }), inspectDraft: () => ({ ready: false, missing: ['name'], issues: [], pending_requirements: [] }) })
  return { brain, time: value => { time = value }, reason: (parsed = price, overrides = {}) => brain.reasonTurn({ scope, revision: null, parsed, context, before: {}, rules: [], locale: 'km', ...overrides }), repeat: (overrides = {}) => brain.interpretReader({ message: 'repeat the last answer' }, dictionary, { scope, revision: null, ...overrides }) }
}
test('reasoning prepares reply but does not commit memory or learning', () => { const f = fixture(); const turn = f.reason(); assert.equal(turn.reply.kind, 'price'); assert.equal(f.repeat().intent, 'unclear'); assert.equal(f.brain.learningSnapshot().counts.handled, 0) })
test('commit stores memory and learning only once', () => { const f = fixture(); const turn = f.reason(); assert.equal(f.brain.commitTurn({ scope, revision: null, turn }).reason, 'handled'); assert.equal(f.repeat().question, 'price'); assert.equal(f.brain.commitTurn({ scope, revision: null, turn }), null); assert.equal(f.brain.learningSnapshot().counts.handled, 1) })
test('wrong scope, revision and copied turn cannot commit', () => { const f = fixture(); const turn = f.reason(); assert.equal(f.brain.commitTurn({ scope: { ...scope, conversationId: scope.actorUserId }, revision: null, turn }), null); assert.equal(f.brain.commitTurn({ scope, revision: 1, turn }), null); assert.equal(f.brain.commitTurn({ scope, revision: null, turn: { ...turn } }), null); assert.equal(f.repeat().intent, 'unclear'); assert.equal(f.brain.learningSnapshot().counts.handled, 0) })
test('question context must match scope', () => { const f = fixture(); assert.throws(() => f.reason(price, { context: { ...context, campaign_id: scope.actorUserId } }), { code: 'SHADOW_AI_SESSION_INVALID' }) })
test('committed metadata ignores caller mutations', () => { const f = fixture(); const turn = f.reason(); turn.parsed.question = 'stock'; turn.confidence.intent_reason = 'unknown_intent'; f.brain.commitTurn({ scope, revision: null, turn }); assert.equal(f.repeat().question, 'price'); assert.equal(f.brain.learningSnapshot().counts.handled, 1) })
test('memory expires and is isolated by conversation', () => { const f = fixture(); f.brain.commitTurn({ scope, revision: null, turn: f.reason() }); assert.equal(f.repeat({ scope: { ...scope, conversationId: scope.actorUserId } }).intent, 'unclear'); f.time(600000); assert.equal(f.repeat().intent, 'unclear') })
test('successful booking clears previous question memory', () => { const f = fixture(); f.brain.commitTurn({ scope, revision: null, turn: f.reason() }); const turn = f.reason({ intent: 'booking', question: null, patch: { name: 'Example Reader' } }); assert.equal(f.brain.commitTurn({ scope, revision: null, turn }), null); assert.equal(f.brain.commitTurn({ scope, revision: 0, turn }).reason, 'handled'); assert.equal(f.repeat({ revision: 0 }).intent, 'unclear') })
test('failed live context does not modify observations', () => { const f = fixture(); assert.throws(() => f.reason(price, { context: { ...context, stock_verified: false } }), { code: 'SHADOW_AI_CAMPAIGN_UNAVAILABLE' }); assert.equal(f.brain.learningSnapshot().counts.handled, 0) })
