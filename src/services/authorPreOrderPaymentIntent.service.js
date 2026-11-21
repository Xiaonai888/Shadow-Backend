import { supabase } from '../config/supabase.js'
import { preOrderError } from './authorPreOrderValidation.service.js'
import {
  createPreOrderPaymentTransaction,
  preOrderPaymentId,
  preOrderPaymentCents,
  preOrderPaymentCurrency,
} from './authorPreOrderPaymentValidation.service.js'

const TABLE = 'author_preorder_payment_intents'
const FIELDS = 'order_id,merchant_transaction_id,expected_amount_usd,currency,expires_at,created_at,finalized_at'

function databaseError(error, action) {
  if (!error) return
  console.error(`PRE_ORDER_PAYMENT_INTENT_${action}:`, String(error.message || error))
  throw preOrderError('PRE_ORDER_PAYMENT_INTENT_STORAGE_UNAVAILABLE', 'Could not access pre-order payment intent', 503)
}

export async function getAuthorPreOrderPaymentIntent(orderId) {
  const id = preOrderPaymentId(orderId)
  const { data, error } = await supabase.from(TABLE).select(FIELDS).eq('order_id', id).maybeSingle()
  databaseError(error, 'READ')
  if (!data) {
    throw preOrderError('PRE_ORDER_PAYMENT_INTENT_NOT_FOUND', 'Payment intent does not exist', 404)
  }
  return data
}

export async function ensureAuthorPreOrderPaymentIntent(orderId, buyerUserId, { expiresAt } = {}) {
  const id = preOrderPaymentId(orderId)
  const buyerId = preOrderPaymentId(buyerUserId, 'buyer account ID')
  const { data: order, error: orderError } = await supabase.from('author_preorder_orders')
    .select('id,payment_status,fulfillment_status,paid_at,total_usd')
    .eq('id', id)
    .eq('buyer_user_id', buyerId)
    .maybeSingle()
  databaseError(orderError, 'ORDER')
  if (!order) throw preOrderError('PRE_ORDER_PAYMENT_ORDER_NOT_FOUND', 'Order not found', 404)
  const amountCents = preOrderPaymentCents(order.total_usd, 'stored order total')
  if (!amountCents) throw preOrderError('PRE_ORDER_PAYMENT_AMOUNT_INVALID', 'Order total is invalid', 409)
  const { data: existing, error: existingError } = await supabase.from(TABLE).select(FIELDS)
    .eq('order_id', id).maybeSingle()
  databaseError(existingError, 'EXISTING')
  if (existing) {
    if (preOrderPaymentCents(existing.expected_amount_usd, 'intent total') !== amountCents ||
        preOrderPaymentCurrency(existing.currency) !== 'USD') {
      throw preOrderError('PRE_ORDER_PAYMENT_INTENT_MISMATCH', 'Stored payment intent does not match the order', 409)
    }
    return existing
  }
  if (order.payment_status !== 'pending' || order.fulfillment_status !== 'awaiting_payment' || order.paid_at) {
    throw preOrderError('PRE_ORDER_PAYMENT_NOT_PENDING', 'Only pending orders can request a payment intent', 409)
  }
  const expires = Date.parse(String(expiresAt ?? ''))
  if (!Number.isFinite(expires) || expires < Date.now() + 60 * 1000 || expires > Date.now() + 60 * 60 * 1000) {
    throw preOrderError('PRE_ORDER_PAYMENT_EXPIRY_INVALID', 'Payment expiry must be within one hour', 400)
  }
  const row = {
    order_id: id,
    merchant_transaction_id: createPreOrderPaymentTransaction(),
    expected_amount_usd: amountCents / 100,
    currency: 'USD',
    expires_at: new Date(expires).toISOString(),
  }
  const { data, error } = await supabase.from(TABLE).insert(row).select(FIELDS).single()
  if (error?.code === '23505') {
    const { data: concurrent, error: readError } = await supabase.from(TABLE).select(FIELDS)
      .eq('order_id', id).maybeSingle()
    databaseError(readError, 'RACE')
    if (concurrent && preOrderPaymentCents(concurrent.expected_amount_usd, 'intent total') === amountCents && concurrent.currency === 'USD') return concurrent
  }
  databaseError(error, 'CREATE')
  if (!data) throw preOrderError('PRE_ORDER_PAYMENT_INTENT_STORAGE_UNAVAILABLE', 'Payment intent creation was not confirmed', 503)
  return data
}
