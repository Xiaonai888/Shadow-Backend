import { normalizeShadowDraftScope } from './shadowAiPreOrderDraftStore.service.js'
import { mergeShadowBookingDraft, inspectShadowBookingDraft } from './shadowAiPreOrderDraft.js'
import { normalizeShadowPreOrderRules } from './shadowAiPreOrderRequirements.js'
import { shadowAiError } from './shadowAiPolicy.js'

export function createShadowAiPreOrderSession({ authorize, authorizeInitial = authorize, contextService, loadConfirmedRules, draftStore, bookingTurn, checkoutReview, commitTurn = null } = {}) {
  if ([authorize,authorizeInitial,contextService?.detail,loadConfirmedRules,draftStore?.load,draftStore?.save,bookingTurn,checkoutReview].some(fn=>typeof fn !== 'function')) throw new TypeError('Booking session dependencies required')
  if (commitTurn !== null && typeof commitTurn !== 'function') throw new TypeError('Booking commit dependency is invalid')
  async function scopeFor(input) {
    const scope = normalizeShadowDraftScope(input)
    if (typeof input.conversationId !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(input.conversationId)) throw shadowAiError('SHADOW_AI_SESSION_INVALID','Invalid booking session',400)
    const initialScope = {...scope,conversationId:input.conversationId.toLowerCase()}
    if (input.accessProof !== undefined) initialScope.accessProof = input.accessProof
    if (await authorizeInitial(initialScope) !== true) throw shadowAiError('SHADOW_AI_SESSION_DENIED','Booking session is unavailable',403)
    return scope
  }
  async function getReady(scope) {
    const context = await contextService.detail(scope.authorPageId,scope.campaignId)
    if (!context.can_book || !context.stock_verified) throw shadowAiError('SHADOW_AI_CAMPAIGN_UNAVAILABLE','This pre-order is unavailable',409)
    const confirmed = await loadConfirmedRules(scope)
    if (confirmed?.confirmed !== true) throw shadowAiError('SHADOW_AI_REQUIREMENTS_UNCONFIRMED','Booking requirements need verification',409)
    return {context,rules:normalizeShadowPreOrderRules(confirmed.rules)}
  }
  return {
    async open(input) {
      const scope = await scopeFor(input)
      const {context,rules} = await getReady(scope)
      const stored = await draftStore.load(scope)
      const draft = mergeShadowBookingDraft(context,stored.draft)
      return {context,rules,draft,revision:stored.revision,expires_at:stored.expires_at,validation:inspectShadowBookingDraft(context,draft,rules)}
    },
    async message(input) {
      const scope = await scopeFor(input)
      if (typeof input.message !== 'string' || !input.message.trim() || input.message.length > 2000) throw shadowAiError('SHADOW_AI_BOOKING_MESSAGE_INVALID','Invalid booking message',400)
      const stored = await draftStore.load(scope)
      if (input.revision !== stored.revision) throw shadowAiError('SHADOW_AI_DRAFT_CONFLICT','Booking draft changed. Reopen and try again.',409)
      const fullScope = {...scope,conversationId:input.conversationId.toLowerCase()}
      const turn = await bookingTurn({...scope,previousDraft:stored.draft,message:input.message,...(commitTurn ? {conversationId:fullScope.conversationId,revision:stored.revision,locale:input.locale} : {})})
      if (turn.author_page_id !== scope.authorPageId || turn.campaign_id !== scope.campaignId || turn.order_created !== false || turn.payment_created !== false || turn.inventory_reserved !== false) throw shadowAiError('SHADOW_AI_SESSION_INVALID','Invalid booking response',503)
      if (await authorize({...scope,conversationId:input.conversationId.toLowerCase()}) !== true) throw shadowAiError('SHADOW_AI_SESSION_DENIED','Booking session is unavailable',403)
      const saved = turn.intent === 'booking' ? await draftStore.save(scope,stored.revision,turn.draft) : {revision:stored.revision,expires_at:stored.expires_at}
      if (commitTurn) commitTurn({scope:fullScope,revision:saved.revision,turn,authorized:true})
      return {...turn,...saved}
    },
    async review(input) {
      const scope = await scopeFor(input)
      const stored = await draftStore.load(scope)
      if (stored.revision === null || input.revision !== stored.revision) throw shadowAiError('SHADOW_AI_DRAFT_CONFLICT','Booking draft changed. Reopen and try again.',409)
      const {context,rules} = await getReady(scope)
      const result = await checkoutReview({actorUserId:scope.actorUserId,context,rules,draft:stored.draft})
      if (await authorize({...scope,conversationId:input.conversationId.toLowerCase()}) !== true) throw shadowAiError('SHADOW_AI_SESSION_DENIED','Booking session is unavailable',403)
      const latest = await draftStore.load(scope)
      if (latest.revision !== stored.revision) throw shadowAiError('SHADOW_AI_DRAFT_CONFLICT','Booking draft changed. Reopen and try again.',409)
      return {...result,revision:stored.revision,expires_at:stored.expires_at}
    },
  }
}
