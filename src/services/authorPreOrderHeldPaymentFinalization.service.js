import { supabase } from '../config/supabase.js'
import { preOrderError, preOrderUuid } from './authorPreOrderValidation.service.js'
import { getAuthorPreOrderPaymentIntent } from './authorPreOrderPaymentIntent.service.js'
import { verifyAuthorPreOrderPayWaySettlement } from './authorPreOrderPayWayVerification.service.js'
import { preOrderPaymentCents } from './authorPreOrderPaymentValidation.service.js'

function failure(error) {
  const code = String(error?.message || '').match(/PRE_ORDER_[A-Z0-9_]+/)?.[0]
  if (code) throw preOrderError(code, 'Verified payment could not be finalized; manual reconciliation is required', 409)
  console.error('PRE_ORDER_HELD_FINALIZATION_DB:', String(error?.code || 'unknown'))
  throw preOrderError('PRE_ORDER_HELD_FINALIZATION_UNAVAILABLE', 'Could not finalize payment safely', 503)
}

export async function reconcileVerifiedHeldPreOrderPayment(orderId, { signal } = {}) {
  const id = preOrderUuid(orderId, 'order ID')
  const intent = await getAuthorPreOrderPaymentIntent(id)
  const { data: order, error: orderError } = await supabase.from('author_preorder_orders')
    .select('id,payment_status,total_usd,payment_reference')
    .eq('id', id).maybeSingle()
  if (orderError) failure(orderError)
  if (!order) throw preOrderError('PRE_ORDER_PAYMENT_ORDER_NOT_FOUND', 'Order was not found', 404)
  if (!['pending', 'paid'].includes(order.payment_status) ||
      (order.payment_reference && order.payment_reference !== intent.merchant_transaction_id) ||
      intent.currency !== 'USD' ||
      preOrderPaymentCents(order.total_usd, 'order total') !==
        preOrderPaymentCents(intent.expected_amount_usd, 'intent total')) {
    throw preOrderError('PRE_ORDER_HELD_PAYMENT_MISMATCH', 'Order and payment intent do not match', 409)
  }

  const { data: hold, error: holdError } = await supabase.from('author_preorder_stock_holds')
    .select('status,expires_at').eq('order_id', id).maybeSingle()
  if (holdError) failure(holdError)
  if (!hold || !['held', 'consumed'].includes(hold.status)) {
    throw preOrderError('PRE_ORDER_HELD_PAYMENT_UNRESERVED', 'Payment needs manual review because stock is not held', 409)
  }

  const settlement = await verifyAuthorPreOrderPayWaySettlement(intent, { signal })
  if (settlement.confirmed !== true) {
    return { order_id: id, verified: false, newly_paid: false, code: settlement.code }
  }

  const { data: finalized, error } = await supabase.rpc('author_preorder_finalize_held_paid', {
    p_order_id: id,
    p_payment_reference: intent.merchant_transaction_id,
    p_provider_paid_at: settlement.provider_paid_at,
  })
  if (error) failure(error)
  if (!finalized || finalized.order_id !== id ||
      ![true, false].includes(finalized.newly_paid) ||
      !Number.isSafeInteger(Number(finalized.successful_order_number)) ||
      Number(finalized.successful_order_number) < 1) {
    throw preOrderError('PRE_ORDER_HELD_FINALIZATION_INVALID', 'Payment finalization result was incomplete', 503)
  }

  if (!intent.finalized_at) {
    const { error: updateError } = await supabase.from('author_preorder_payment_intents')
      .update({ finalized_at: new Date().toISOString() })
      .eq('order_id', id).is('finalized_at', null)
    if (updateError) {
      console.error('PRE_ORDER_HELD_FINALIZATION_MARKER_FAILED:', String(updateError.code || 'unknown'))
    }
  }
  return {
    order_id: id,
    verified: true,
    newly_paid: finalized.newly_paid,
    successful_order_number: Number(finalized.successful_order_number),
    service_fee_usd: Number(finalized.service_fee_usd),
    paid_at: finalized.paid_at,
  }
}
