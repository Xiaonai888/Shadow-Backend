import { supabase } from '../config/supabase.js'
import { preOrderError } from './authorPreOrderValidation.service.js'
import { getAuthorPreOrderPaymentIntent } from './authorPreOrderPaymentIntent.service.js'
import { verifyAuthorPreOrderPayWaySettlement } from './authorPreOrderPayWayVerification.service.js'
import { preOrderPaymentCents, preOrderPaymentId } from './authorPreOrderPaymentValidation.service.js'

function databaseError(error, scope) {
  if (!error) return
  console.error(`PRE_ORDER_PAYMENT_FINALIZATION_${scope}:`, String(error.message || error))
  const known = String(error.message || '').match(/PRE_ORDER_[A-Z0-9_]+/)
  if (known) {
    throw preOrderError('PRE_ORDER_PAYMENT_FINALIZATION_REJECTED', 'Payment could not be finalized automatically', 409)
  }
  throw preOrderError('PRE_ORDER_PAYMENT_FINALIZATION_UNAVAILABLE', 'Payment finalization is unavailable', 503)
}

export async function reconcileVerifiedAuthorPreOrderPayment(orderId, { signal } = {}) {
  const id = preOrderPaymentId(orderId)
  const intent = await getAuthorPreOrderPaymentIntent(id)
  const { data: order, error } = await supabase.from('author_preorder_orders')
    .select('id,payment_status,fulfillment_status,paid_at,payment_reference,total_usd')
    .eq('id', id).maybeSingle()
  databaseError(error, 'ORDER')
  if (!order) throw preOrderError('PRE_ORDER_PAYMENT_ORDER_NOT_FOUND', 'Pre-order does not exist', 404)
  if (!['pending', 'paid'].includes(order.payment_status)) {
    throw preOrderError('PRE_ORDER_PAYMENT_NOT_PENDING', 'Order is no longer payable', 409)
  }
  if (order.payment_status === 'pending' && (order.fulfillment_status !== 'awaiting_payment' || order.paid_at)) {
    throw preOrderError('PRE_ORDER_PAYMENT_STATE_INVALID', 'Order payment state is invalid', 409)
  }
  if (order.payment_reference && order.payment_reference !== intent.merchant_transaction_id) {
    throw preOrderError('PRE_ORDER_PAYMENT_REFERENCE_MISMATCH', 'Payment reference does not match the saved intent', 409)
  }
  const expected = preOrderPaymentCents(intent.expected_amount_usd, 'intent amount')
  if (!expected || expected !== preOrderPaymentCents(order.total_usd, 'order total') || intent.currency !== 'USD') {
    throw preOrderError('PRE_ORDER_PAYMENT_AMOUNT_MISMATCH', 'Order amount does not match the payment intent', 409)
  }
  const settlement = await verifyAuthorPreOrderPayWaySettlement(intent, { signal })
  if (!settlement.confirmed) {
    return { order_id: id, newly_paid: false, verified: false, code: settlement.code }
  }
  const { data: result, error: finalizeError } = await supabase.rpc('author_preorder_finalize_paid', {
    p_order_id: id,
    p_payment_reference: intent.merchant_transaction_id,
    p_provider_paid_at: settlement.provider_paid_at,
  })
  databaseError(finalizeError, 'RPC')
  if (!result || result.order_id !== id || result.newly_paid !== true && result.newly_paid !== false ||
      !Number.isSafeInteger(Number(result.successful_order_number)) || Number(result.successful_order_number) < 1) {
    throw preOrderError('PRE_ORDER_PAYMENT_FINALIZATION_INVALID', 'Payment finalization response is invalid', 503)
  }
  if (!intent.finalized_at) {
    const { error: markerError } = await supabase.from('author_preorder_payment_intents')
      .update({ finalized_at: new Date().toISOString() })
      .eq('order_id', id)
      .is('finalized_at', null)
    if (markerError) {
      console.error('PRE_ORDER_PAYMENT_FINALIZED_MARKER_FAILED:', String(markerError.message || markerError))
    }
  }
  return {
    order_id: id,
    verified: true,
    newly_paid: result.newly_paid,
    successful_order_number: Number(result.successful_order_number),
    service_fee_usd: Number(result.service_fee_usd),
    paid_at: result.paid_at,
  }
}
