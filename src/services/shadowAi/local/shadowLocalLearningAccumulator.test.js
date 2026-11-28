import test from 'node:test'
import assert from 'node:assert/strict'
import { createShadowLocalLearningAccumulator as create } from './shadowLocalLearningAccumulator.js'
import { SHADOW_LOCAL_OBSERVATION_KEYS } from './shadowLocalMistakeDetection.js'

const unknown = { correction: { applied: false, reason: null }, confidence: { score_kind: 'rule_evidence_not_accuracy_probability', decision: 'clarify', intent_reason: 'unknown_intent', intent_score: 0 } }
test('100 unknown occurrences produce one bounded review category', () => {
  const store = create()
  for (let i = 0; i < 100; i++) store.observe(unknown)
  assert.deepEqual(store.snapshot().pending_review, [{ reason: 'unknown_intent', occurrences: 100, status: 'pending_review' }])
  assert.equal(Object.keys(store.snapshot().counts).length, SHADOW_LOCAL_OBSERVATION_KEYS.length)
  assert.equal(store.snapshot().accuracy_verified, false)
})
test('does not retain raw messages or private data, even in untrusted reason', () => {
  const store = create()
  store.observe({ ...unknown, message: 'PRIVATE NAME', draft: { phone_number: '012345678' }, actorUserId: 'private-id' })
  for (let i = 0; i < 1000; i++) store.observe({ correction: { applied: true, reason: `SECRET-${i}` } })
  const snapshot = store.snapshot()
  assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE NAME|012345678|private-id|SECRET/)
  assert.equal(snapshot.counts.unclassified, 1000)
  assert.equal(Object.keys(snapshot.counts).length, SHADOW_LOCAL_OBSERVATION_KEYS.length)
})
test('snapshot is isolated and take clears only current counters', () => {
  const store = create()
  store.observe(unknown)
  const first = store.snapshot()
  first.counts.unknown_intent = 999
  first.pending_review[0].occurrences = 999
  assert.equal(store.take().counts.unknown_intent, 1)
  assert.equal(store.snapshot().counts.unknown_intent, 0)
  store.observe(unknown)
  assert.equal(store.snapshot().counts.unknown_intent, 1)
})
test('independent accumulators have no shared retained state', () => {
  const a = create(), b = create()
  a.observe(unknown)
  assert.equal(b.snapshot().counts.unknown_intent, 0)
  assert.equal(a.snapshot().persistence, 'process_memory')
})
