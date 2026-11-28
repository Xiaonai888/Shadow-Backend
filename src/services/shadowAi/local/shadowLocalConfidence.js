import { BOOKING_TEXT_LIMITS, normalizeBookingItems, normalizeBookingText } from '../shadowAiPreOrderMessage.js'

export const SHADOW_LOCAL_CONFIDENCE_VERSION = 'shadow-local-evidence-v1'
const questions = new Set(['books', 'price', 'stock', 'delivery', 'signature', 'schedule', 'requirements'])
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)

function inspectPatch(patch, context) {
  if (!record(patch)) return { valid: false, evidence: false }
  const entries = Object.entries(patch)
  if (entries.length > Object.keys(BOOKING_TEXT_LIMITS).length + 2) return { valid: false, evidence: false }
  try {
    for (const [key, value] of entries) {
      if (key === 'items') {
        if (!Array.isArray(context?.books) || context.books.length > 10) return { valid: false, evidence: false }
        const items = normalizeBookingItems(value, context)
        if (items.some(item => item.edition !== null && !context.books.find(book => book.id === item.book_id)?.editions?.some(edition => edition?.edition === item.edition))) return { valid: false, evidence: false }
      } else if (key === 'signature_requested') {
        if (typeof value !== 'boolean' || (value && context?.signature_enabled !== true)) return { valid: false, evidence: false }
      } else if (Object.hasOwn(BOOKING_TEXT_LIMITS, key)) {
        normalizeBookingText(key, value)
        if (key === 'delivery_company_key' && value && (!Array.isArray(context?.delivery_companies) || !context.delivery_companies.some(company => company?.company_key === value))) return { valid: false, evidence: false }
      } else return { valid: false, evidence: false }
    }
  } catch {
    return { valid: false, evidence: false }
  }
  return { valid: true, evidence: entries.length > 0 }
}

function contextStatus(context) {
  if (!record(context)) return 'unavailable'
  if (context.stock_verified !== true) return 'unverified'
  if (context.can_book !== true) return 'campaign_unavailable'
  return 'verified_context'
}

function reviewStatus(validation, knowledge) {
  if (knowledge !== 'verified_context') return 'blocked'
  if (!record(validation) || typeof validation.ready !== 'boolean' || !['missing', 'issues', 'pending_requirements'].every(key => Array.isArray(validation[key]))) return 'unverified'
  if (validation.issues.length > 0) return 'blocked'
  if (validation.missing.length > 0 || validation.pending_requirements.length > 0) return 'needs_information'
  return validation.ready === true ? 'review_only' : 'unverified'
}

export function assessShadowLocalConfidence({ parsed, context, validation } = {}) {
  const knowledge = contextStatus(context)
  let score = 0, reason = 'unknown_intent', decision = 'clarify', action = 'not_requested'
  if (record(parsed)) {
    const patch = inspectPatch(parsed.patch, context)
    if (parsed.intent === 'question' && patch.valid && !patch.evidence) {
      score = questions.has(parsed.question) ? 100 : 50
      reason = score === 100 ? 'known_question_category' : 'question_category_missing'
      if (score === 100) decision = knowledge === 'verified_context' ? 'inspect_question' : 'unavailable'
    } else if (parsed.intent === 'booking' && patch.valid && (parsed.question === null || questions.has(parsed.question))) {
      score = patch.evidence ? 100 : 50
      reason = patch.evidence ? 'validated_booking_patch' : 'booking_details_missing'
      if (patch.evidence) {
        action = reviewStatus(validation, knowledge)
        decision = action === 'review_only' ? 'offer_review' : action === 'needs_information' ? 'ask_missing_details' : 'unavailable'
      }
    } else if (parsed.intent === 'unrelated' && parsed.question === null && patch.valid && !patch.evidence) {
      reason = 'outside_supported_scope'
      decision = 'out_of_scope'
    } else if (parsed.intent !== 'unclear' || !patch.valid || patch.evidence || parsed.question !== null) {
      reason = 'invalid_or_conflicting_output'
    }
  }
  return {
    version: SHADOW_LOCAL_CONFIDENCE_VERSION,
    score_kind: 'rule_evidence_not_accuracy_probability',
    intent_score: score,
    intent_reason: reason,
    knowledge_status: knowledge,
    action_status: action,
    decision,
  }
}
