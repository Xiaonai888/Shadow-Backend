import { supabase } from '../config/supabase.js'
import { preOrderError, preOrderUuid } from './authorPreOrderValidation.service.js'

function storageError(error, scope) {
  if (!error) return
  console.error(`PRE_ORDER_RECONCILIATION_INSPECT_${scope}:`, String(error.code || 'unknown'))
  throw preOrderError('PRE_ORDER_RECONCILIATION_STORAGE_UNAVAILABLE', 'Payment reconciliation information is unavailable', 503)
}

export async function inspectAuthorPreOrderReconciliation(orderId) {
  const id = preOrderUuid(orderId, 'order ID')
  const { data: order, error: orderError } = await supabase.from('author_preorder_orders')
    .select('id,author_page_id,payment_status,fulfillment_status,paid_at,payment_reference,total_usd')
    .eq('id', id).maybeSingle()
  storageError(orderError, 'ORDER')
  if (!order) throw preOrderError('PRE_ORDER_RECONCILIATION_ORDER_NOT_FOUND', 'Pre-order does not exist', 404)

  const [holdResult, intentResult, ledgerResult, reviewResult] = await Promise.all([
    supabase.from('author_preorder_stock_holds')
      .select('status,expires_at,consumed_at,released_at').eq('order_id', id).maybeSingle(),
    supabase.from('author_preorder_payment_intents')
      .select('currency,expected_amount_usd,expires_at,finalized_at,merchant_transaction_id').eq('order_id', id).maybeSingle(),
    supabase.from('author_preorder_fee_ledger')
      .select('successful_order_number,service_fee_usd').eq('order_id', id).maybeSingle(),
    supabase.from('author_preorder_terminal_reviews')
      .select('released_at,review_count,last_checked_at').eq('order_id', id).maybeSingle(),
  ])
  storageError(holdResult.error, 'HOLD')
  storageError(intentResult.error, 'INTENT')
  storageError(ledgerResult.error, 'LEDGER')
  storageError(reviewResult.error, 'TERMINAL')

  const hold = holdResult.data
  const intent = intentResult.data
  const ledger = ledgerResult.data
  const review = reviewResult.data
  const issues = []
  if (!hold) issues.push('PRE_ORDER_RECON_HOLD_MISSING')
  if (intent && (intent.currency !== 'USD' || Number(intent.expected_amount_usd) !== Number(order.total_usd))) {
    issues.push('PRE_ORDER_RECON_INTENT_AMOUNT_MISMATCH')
  }
  if (order.payment_reference && intent && order.payment_reference !== intent.merchant_transaction_id) {
    issues.push('PRE_ORDER_RECON_REFERENCE_MISMATCH')
  }
  if (order.payment_status === 'paid') {
    if (!order.paid_at || !ledger) issues.push('PRE_ORDER_RECON_PAID_LEDGER_MISMATCH')
    if (hold?.status !== 'consumed') issues.push('PRE_ORDER_RECON_PAID_HOLD_MISMATCH')
    if (!intent) issues.push('PRE_ORDER_RECON_PAID_INTENT_MISSING')
  } else if (order.payment_status === 'pending') {
    if (order.paid_at || order.fulfillment_status !== 'awaiting_payment' || ledger) {
      issues.push('PRE_ORDER_RECON_PENDING_STATE_MISMATCH')
    }
    if (hold && hold.status !== 'held') issues.push('PRE_ORDER_RECON_PENDING_HOLD_MISMATCH')
  } else if (ledger || hold?.status === 'consumed') {
    issues.push('PRE_ORDER_RECON_TERMINAL_PAID_MISMATCH')
  }
  if (review?.released_at && hold?.status !== 'released') issues.push('PRE_ORDER_RECON_RELEASE_MISMATCH')

  const expiresMs = Date.parse(String(hold?.expires_at || ''))
  return {
    order_id: id,
    payment_status: String(order.payment_status),
    fulfillment_status: String(order.fulfillment_status),
    hold_status: hold?.status || 'missing',
    hold_expires_at: hold?.expires_at || null,
    hold_expired: Number.isFinite(expiresMs) && expiresMs <= Date.now(),
    has_payment_intent: Boolean(intent),
    has_fee_ledger: Boolean(ledger),
    has_terminal_review: Boolean(review),
    review_count: Number(review?.review_count || 0),
    issues,
    requires_manual_review: issues.length > 0,
    can_check_provider: issues.length === 0 && order.payment_status === 'pending' && hold?.status === 'held' && Boolean(intent),
  }
}
