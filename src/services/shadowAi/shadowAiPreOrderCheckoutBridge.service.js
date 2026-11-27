import { inspectShadowPreOrderAddress } from './shadowAiPreOrderAddress.js'
import { mergeShadowBookingDraft, inspectShadowBookingDraft } from './shadowAiPreOrderDraft.js'
import { shadowAiError } from './shadowAiPolicy.js'

export function buildShadowAiReviewInput(context, storedDraft, rules) {
  const draft = mergeShadowBookingDraft(context,storedDraft)
  const validation = inspectShadowBookingDraft(context,draft,rules)
  if (!validation.ready) throw shadowAiError('SHADOW_AI_BOOKING_NOT_READY','Booking information is incomplete or unavailable',409)
  const address = inspectShadowPreOrderAddress(draft.delivery_address)
  const canonical = address.province_city === 'ភ្នំពេញ' ? 'រាជធានីភ្នំពេញ' : `ខេត្ត${address.province_city}`
  const deliveryAddress = draft.delivery_address.length >= 6 ? draft.delivery_address : canonical
  return {
    input:{ items:draft.items,delivery_company_key:draft.delivery_company_key,signature_requested:draft.signature_requested,
      signature_name:draft.signature_name,buyer_note:draft.buyer_note,
      buyer:{name:draft.name,phone_number:draft.phone_number,delivery_address:deliveryAddress,province_city:address.province_city,
        telegram_username:draft.telegram_username,facebook_link:draft.facebook_link} },
    additional_requirements:Object.fromEntries(['second_phone','english_buyer_name','english_signature_name','detailed_address'].filter(k=>draft[k]).map(k=>[k,draft[k]])),
    original_delivery_address:draft.delivery_address,
  }
}
export function createShadowAiCheckoutBridge({ prepareReview } = {}) {
  if (typeof prepareReview !== 'function') throw new TypeError('Review dependency required')
  return async function review({ actorUserId,context,draft,rules }) {
    const built = buildShadowAiReviewInput(context,draft,rules)
    const result = await prepareReview(context.campaign_id,actorUserId,built.input)
    if (!result || result.campaign_id !== context.campaign_id || result.preview_only !== true || result.order_created !== false || result.inventory_reserved !== false || result.payment_created !== false || result.stock_snapshot_complete !== true) throw shadowAiError('SHADOW_AI_REVIEW_INVALID','Booking preview could not be verified',503)
    return { review:result,additional_requirements:built.additional_requirements,original_delivery_address:built.original_delivery_address,
      can_confirm_payment:false,order_created:false,payment_created:false,inventory_reserved:false }
  }
}
