export const SHADOW_LOCAL_MISTAKE_VERSION = 'shadow-local-mistake-v1'
export const SHADOW_LOCAL_LEARNING_REASONS = Object.freeze([
  'unknown_intent', 'invalid_or_conflicting_output', 'booking_details_missing', 'question_category_missing',
])
const corrections = new Set(SHADOW_LOCAL_LEARNING_REASONS.slice(1))
const outcomes = new Set(['handled', 'out_of_scope', 'unavailable', 'unclassified'])
export const SHADOW_LOCAL_OBSERVATION_KEYS = Object.freeze([...SHADOW_LOCAL_LEARNING_REASONS, ...outcomes])

export function detectShadowLocalMistake(turn) {
  const confidence = turn?.confidence
  const correction = turn?.correction
  const result = (reason, needsReview = false) => ({ version: SHADOW_LOCAL_MISTAKE_VERSION, reason, needs_review: needsReview })
  if (correction?.applied === true) return corrections.has(correction.reason) ? result(correction.reason, true) : result('unclassified')
  if (correction?.applied !== false || correction.reason !== null || confidence?.score_kind !== 'rule_evidence_not_accuracy_probability') return result('unclassified')
  if (confidence.decision === 'out_of_scope' && confidence.intent_reason === 'outside_supported_scope') return result('out_of_scope')
  if (confidence.decision === 'unavailable') return result('unavailable')
  if (confidence.decision === 'clarify' && confidence.intent_score === 0 && confidence.intent_reason === 'unknown_intent') return result('unknown_intent', true)
  if (confidence.intent_score === 100 && ((confidence.intent_reason === 'known_question_category' && confidence.decision === 'inspect_question') || (confidence.intent_reason === 'validated_booking_patch' && ['ask_missing_details', 'offer_review'].includes(confidence.decision)))) return result('handled')
  return result('unclassified')
}
