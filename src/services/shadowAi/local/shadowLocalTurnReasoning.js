import { guardShadowLocalTurn } from './shadowLocalTurnGuard.js'
import { assessShadowLocalConfidence } from './shadowLocalConfidence.js'
import { shadowAiError } from '../shadowAiPolicy.js'

export function createShadowLocalTurnReasoning({ mergeDraft, inspectDraft } = {}) {
  if (typeof mergeDraft !== 'function' || typeof inspectDraft !== 'function') throw new TypeError('Turn reasoning dependencies required')
  return function reasonTurn({ parsed, context, before, rules } = {}) {
    if (context?.can_book !== true || context?.stock_verified !== true) throw shadowAiError('SHADOW_AI_CAMPAIGN_UNAVAILABLE', 'This pre-order is unavailable', 409)
    const guarded = guardShadowLocalTurn({ parsed, context })
    const safeParsed = guarded.parsed
    const draft = mergeDraft(context, before, safeParsed.patch)
    const validation = inspectDraft(context, draft, rules)
    if (typeof validation?.ready !== 'boolean' || !['missing', 'issues', 'pending_requirements'].every(key => Array.isArray(validation[key])) || (validation.ready && (validation.missing.length || validation.issues.length || validation.pending_requirements.length))) {
      throw shadowAiError('SHADOW_AI_SESSION_INVALID', 'Invalid booking validation', 503)
    }
    const confidence = assessShadowLocalConfidence({ parsed: safeParsed, context, validation })
    return { parsed: safeParsed, draft, validation, confidence, correction: { applied: guarded.corrected, reason: guarded.reason } }
  }
}
