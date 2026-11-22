import { supabase } from '../config/supabase.js'
import { preOrderError, preOrderUuid } from './authorPreOrderValidation.service.js'
import { inspectAuthorPreOrderMultiVolumeReconciliation } from './authorPreOrderMultiVolumeReconciliationInspector.service.js'
import { assessAuthorPreOrderMultiVolumeTerminalEligibility } from './authorPreOrderMultiVolumeTerminalPolicy.service.js'

export async function inspectAuthorPreOrderMultiVolumeTerminalPreflight(orderId) {
  const id = preOrderUuid(orderId, 'order ID').toLowerCase()
  const inspection = await inspectAuthorPreOrderMultiVolumeReconciliation(id)
  const [intentResult, reviewResult] = await Promise.all([
    supabase.from('author_preorder_payment_intents')
      .select('merchant_transaction_id,currency,expires_at,finalized_at')
      .eq('order_id', id).maybeSingle(),
    supabase.from('author_preorder_terminal_reviews')
      .select('merchant_transaction_id,review_count,first_checked_at,last_checked_at,released_at')
      .eq('order_id', id).maybeSingle(),
  ])
  if (intentResult.error || reviewResult.error) {
    console.error('PRE_ORDER_MULTI_TERMINAL_PREFLIGHT_DB:',
      String(intentResult.error?.code || reviewResult.error?.code || 'unknown'))
    throw preOrderError('PRE_ORDER_MULTI_TERMINAL_PREFLIGHT_UNAVAILABLE', 'Terminal preflight records are unavailable', 503)
  }
  const intent = intentResult.data
  const review = reviewResult.data
  const eligibility = assessAuthorPreOrderMultiVolumeTerminalEligibility(inspection, intent, review)
  return {
    order_id: id,
    hold_type: inspection.hold_type,
    item_count: inspection.item_count,
    payment_status: inspection.payment_status,
    hold_status: inspection.hold_status,
    hold_expires_at: inspection.hold_expires_at,
    has_payment_intent: Boolean(intent),
    review_count: Number(review?.review_count || 0),
    ...eligibility,
    read_only: true,
    provider_checked: false,
    stock_released: false,
    automatic_release: false,
  }
}
