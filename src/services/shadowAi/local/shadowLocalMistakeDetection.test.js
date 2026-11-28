import test from 'node:test'
import assert from 'node:assert/strict'
import { detectShadowLocalMistake as detect } from './shadowLocalMistakeDetection.js'

const turn = (decision, intent_reason, intent_score = 100) => ({ correction: { applied: false, reason: null }, confidence: { decision, intent_reason, intent_score, score_kind: 'rule_evidence_not_accuracy_probability' } })
test('unknown intent is a review signal, not measured inaccuracy', () => {
  assert.deepEqual(detect(turn('clarify', 'unknown_intent', 0)), { version: 'shadow-local-mistake-v1', reason: 'unknown_intent', needs_review: true })
})
for (const reason of ['invalid_or_conflicting_output', 'booking_details_missing', 'question_category_missing']) test(`guard correction: ${reason}`, () => {
  const input = { ...turn('clarify', 'unknown_intent', 0), correction: { applied: true, reason } }
  assert.equal(detect(input).reason, reason)
  assert.equal(detect(input).needs_review, true)
})
test('normal missing booking details do not imply AI error', () => {
  assert.equal(detect(turn('ask_missing_details', 'validated_booking_patch')).reason, 'handled')
  assert.equal(detect(turn('offer_review', 'validated_booking_patch')).reason, 'handled')
  assert.equal(detect(turn('inspect_question', 'known_question_category')).reason, 'handled')
})
test('stock and availability failures are not learning mistakes', () => {
  assert.equal(detect(turn('unavailable', 'validated_booking_patch')).reason, 'unavailable')
  assert.equal(detect(turn('out_of_scope', 'outside_supported_scope', 0)).reason, 'out_of_scope')
})
test('unrecognized or inconsistent metadata stays unclassified', () => {
  for (const value of [undefined, {}, { correction: { applied: true, reason: 'PRIVATE' } }, turn('clarify', 'unknown_intent', 100), turn('offer_review', 'unknown_intent')]) {
    assert.equal(detect(value).reason, 'unclassified')
    assert.equal(detect(value).needs_review, false)
  }
})
