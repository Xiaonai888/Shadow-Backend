import test from 'node:test'
import assert from 'node:assert/strict'
import { createShadowLocalFeedback as create } from './shadowLocalFeedback.service.js'

const scope = { actorUserId: '11111111-1111-4111-8111-111111111111', conversationId: '22222222-2222-4222-8222-222222222222', campaignId: '33333333-3333-4333-8333-333333333333' }
const other = { ...scope, actorUserId: scope.campaignId }
test('only one valid rating per issued receipt', () => {
  const store = create(), token = store.issue(scope)
  assert.match(token, /^[a-f0-9]{48}$/)
  assert.deepEqual(store.submit({ token, scope, rating: 'correct' }), { accepted: true })
  assert.deepEqual(store.submit({ token, scope, rating: 'incorrect' }), { accepted: false })
  assert.deepEqual(store.snapshot().counts, { correct: 1, incorrect: 0 })
})
test('cross actor, conversation and campaign cannot consume receipt', () => {
  const store = create(), token = store.issue(scope)
  for (const invalid of [other, { ...scope, conversationId: scope.actorUserId }, { ...scope, campaignId: scope.actorUserId }]) assert.equal(store.submit({ token, scope: invalid, rating: 'incorrect' }).accepted, false)
  assert.equal(store.submit({ token, scope, rating: 'incorrect' }).accepted, true)
})
test('expiry and bounded capacity without timer or eviction of live receipt', () => {
  let time = 0
  const store = create({ now: () => time, ttlMs: 1000, maxPending: 1 })
  const token = store.issue(scope)
  assert.equal(store.issue(other), null)
  time = 1000
  assert.equal(store.submit({ token, scope, rating: 'correct' }).accepted, false)
  assert.ok(store.issue(other))
})
test('capacity prunes expired receipts on demand', () => {
  let time = 0
  const store = create({ now: () => time, ttlMs: 1000, maxPending: 1 })
  store.issue(scope)
  time = 1000
  assert.ok(store.issue(other))
})
test('invalid input does not count or consume an issued receipt', () => {
  const store = create(), token = store.issue(scope)
  assert.equal(store.issue({}), null)
  assert.equal(store.submit({ token, scope, rating: 'unknown' }).accepted, false)
  assert.equal(store.submit({ token: 'fake', scope, rating: 'correct' }).accepted, false)
  assert.equal(store.submit({ token, scope, rating: 'correct' }).accepted, true)
  const snapshot = store.snapshot()
  assert.equal(snapshot.accuracy_verified, false)
  assert.doesNotMatch(JSON.stringify(snapshot), /11111111|22222222|33333333/)
  snapshot.counts.correct = 0
  assert.equal(store.snapshot().counts.correct, 1)
})
