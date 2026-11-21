import { supabase } from '../config/supabase.js'
import { preOrderError, preOrderUuid } from './authorPreOrderValidation.service.js'
import { getAuthorPreOrderPaymentIntent } from './authorPreOrderPaymentIntent.service.js'
import { verifyAuthorPreOrderPayWaySettlement } from './authorPreOrderPayWayVerification.service.js'
import { preOrderPaymentCents } from './authorPreOrderPaymentValidation.service.js'

function databaseError(error, action) {
  const code = String(error?.message || '').match(/PRE_ORDER_[A-Z0-9_]+/)?.[0]
  if (code) throw preOrderError(code, 'Multi-volume settlement requires review', 409)
  console.error(`PRE_ORDER_MULTI_PAYMENT_${action}_DB:`, String(error?.code || 'unknown'))
  throw preOrderError('PRE_ORDER_MULTI_PAYMENT_UNAVAILABLE', 'Multi-volume payment could not be finalized', 503)
}

export async function reconcileVerifiedMultiVolumePayment(orderId, { signal } = {}) {
  const id = preOrderUuid(orderId, 'order ID').toLowerCase()
  const intent = await getAuthorPreOrderPaymentIntent(id)
  const { data: order, error } = await supabase.from('author_preorder_orders')
    .select('id,payment_status,fulfillment_status,paid_at,payment_reference,total_usd')
    .eq('id', id).maybeSingle()
  if (error) databaseError(error, 'ORDER')
  if (!order) throw preOrderError('PRE_ORDER_MULTI_PAYMENT_NOT_FOUND', 'Order was not found', 404)
  if (!['pending','paid'].includes(order.payment_status) ||
      order.payment_reference && order.payment_reference !== intent.merchant_transaction_id ||
      intent.currency !== 'USD' ||
      preOrderPaymentCents(order.total_usd, 'order total') !==
      preOrderPaymentCents(intent.expected_amount_usd, 'payment intent total')) {
    throw preOrderError('PRE_ORDER_MULTI_PAYMENT_MISMATCH', 'Order and payment intent disagree', 409)
  }
  if (order.payment_status === 'pending' &&
      (order.paid_at || order.fulfillment_status !== 'awaiting_payment')) {
    throw preOrderError('PRE_ORDER_MULTI_PAYMENT_STATE_INVALID', 'Pending payment state is invalid', 409)
  }
  const result = await verifyAuthorPreOrderPayWaySettlement(intent, { signal })
  if (result.confirmed !== true) {
    return { order_id: id, verified: false, newly_paid: false, code: result.code }
  }
  const { data, error: finalizeError } = await supabase.rpc('author_preorder_finalize_multivolume_paid', {
    p_order_id: id,
    p_payment_reference: intent.merchant_transaction_id,
    p_provider_paid_at: result.provider_paid_at,
  })
  if (finalizeError) databaseError(finalizeError, 'FINALIZE')
  if (!data || data.order_id !== id || ![true,false].includes(data.newly_paid) ||
      data.hold_status !== 'consumed' ||
      !Number.isSafeInteger(Number(data.item_count)) || Number(data.item_count) < 1 ||
      Number(data.item_count) > 10 ||
      !Number.isSafeInteger(Number(data.successful_order_number)) ||
      Number(data.successful_order_number) < 1) {
    throw preOrderError('PRE_ORDER_MULTI_PAYMENT_FINALIZATION_INVALID', 'Payment finalization was not confirmed', 503)
  }
  if (!intent.finalized_at) {
    const { error: markError } = await supabase.from('author_preorder_payment_intents')
      .update({ finalized_at: new Date().toISOString() })
      .eq('order_id', id).is('finalized_at', null)
    if (markError) {
      console.error('PRE_ORDER_MULTI_PAYMENT_MARKER_ERROR:', String(markError.code || 'unknown'))
    }
  }
  return {
    order_id: id,
    verified: true,
    newly_paid: data.newly_paid,
    item_count: Number(data.item_count),
    successful_order_number: Number(data.successful_order_number),
    service_fee_usd: Number(data.service_fee_usd),
    paid_at: data.paid_at,
  }
}

export async function releaseUninitializedExpiredMultiVolumeHold(orderId) {
  const id = preOrderUuid(orderId, 'order ID').toLowerCase()
  const { data, error } = await supabase.rpc('author_preorder_release_uninitialized_multivolume_hold', {
    p_order_id: id,
  })
  if (error) databaseError(error, 'RELEASE')
  if (!data || data.order_id !== id || data.released !== true ||
      ![true,false].includes(data.reused)) {
    throw preOrderError('PRE_ORDER_MULTI_RELEASE_INVALID', 'Expiry release was not confirmed', 503)
  }
  return { order_id: id, released: true, reused: data.reused }
}
