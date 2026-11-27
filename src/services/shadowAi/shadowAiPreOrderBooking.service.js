import { mergeShadowBookingDraft, inspectShadowBookingDraft } from './shadowAiPreOrderDraft.js'
import { parseShadowPreOrderMessage } from './shadowAiPreOrderMessage.js'
import { normalizeShadowPreOrderRules } from './shadowAiPreOrderRequirements.js'
import { shadowAiError } from './shadowAiPolicy.js'

export function createShadowPreOrderBooking({ contextService, runAi, loadConfirmedRules } = {}) {
  if (typeof contextService?.detail !== 'function' || typeof runAi !== 'function' || typeof loadConfirmedRules !== 'function') throw new TypeError('Booking dependencies are required')
  return async function bookingTurn({ actorUserId, authorPageId, campaignId, previousDraft = {}, message }) {
    const context = await contextService.detail(authorPageId,campaignId)
    if (!context.can_book || !context.stock_verified) throw shadowAiError('SHADOW_AI_CAMPAIGN_UNAVAILABLE','This pre-order is unavailable',409)
    const requirements = await loadConfirmedRules({ authorPageId, campaignId })
    if (!requirements || requirements.confirmed !== true) throw shadowAiError('SHADOW_AI_REQUIREMENTS_UNCONFIRMED','Booking requirements need verification',409)
    const rules = normalizeShadowPreOrderRules(requirements.rules)
    const before = mergeShadowBookingDraft(context,previousDraft)
    const parsed = await parseShadowPreOrderMessage({actorUserId,message,context,draft:before,rules,runAi})
    const draft = mergeShadowBookingDraft(context,before,parsed.patch)
    const validation = inspectShadowBookingDraft(context,draft,rules)
    return { campaign_id:context.campaign_id,author_page_id:context.author_page_id,intent:parsed.intent,question:parsed.question,draft,validation,ready_for_review:validation.ready,order_created:false,payment_created:false,inventory_reserved:false }
  }
}
