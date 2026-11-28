import { assessShadowLocalConfidence } from './shadowLocalConfidence.js'

const unclear = () => ({ intent: 'unclear', question: null, patch: {} })
const decision = (parsed, reason = null) => ({ parsed, corrected: reason !== null, reason })

export function guardShadowLocalTurn({ parsed, context } = {}) {
  const assessment = assessShadowLocalConfidence({ parsed, context })
  if (assessment.intent_reason === 'invalid_or_conflicting_output') return decision(unclear(), 'invalid_or_conflicting_output')
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return decision(unclear(), 'invalid_or_conflicting_output')
  if (parsed.intent === 'booking' && assessment.intent_reason !== 'validated_booking_patch') return decision(unclear(), 'booking_details_missing')
  if (parsed.intent === 'question' && assessment.intent_reason !== 'known_question_category') return decision(unclear(), 'question_category_missing')
  if (parsed.intent === 'unclear' || parsed.intent === 'unrelated') return decision({ intent: parsed.intent, question: null, patch: {} })
  return decision({ intent: parsed.intent, question: parsed.question, patch: parsed.patch })
}
