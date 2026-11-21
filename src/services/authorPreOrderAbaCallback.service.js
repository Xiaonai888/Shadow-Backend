import { supabase } from '../config/supabase.js'
import { preOrderError } from './authorPreOrderValidation.service.js'
import { preOrderPaymentTransaction, preOrderPaymentId } from './authorPreOrderPaymentValidation.service.js'
import { reconcileVerifiedHeldPreOrderPayment } from './authorPreOrderHeldPaymentFinalization.service.js'
import { queueVerifiedAuthorPreOrderPaidNotifications } from './authorPreOrderPaidNotification.service.js'

export function parseAuthorPreOrderCallbackTransaction(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw preOrderError('PRE_ORDER_CALLBACK_INVALID', 'Payment callback body is invalid', 400)
  }
  const candidates = [body.tran_id, body.merchant_ref, body.data?.tran_id]
    .filter(value => value !== null && value !== undefined && value !== '')
  if (!candidates.length || candidates.some(value => typeof value !== 'string')) {
    throw preOrderError('PRE_ORDER_CALLBACK_TRANSACTION_MISSING', 'Payment transaction was not supplied', 400)
  }
  const distinct = new Set(candidates.map(value => value.trim()))
  if (distinct.size !== 1) {
    throw preOrderError('PRE_ORDER_CALLBACK_TRANSACTION_CONFLICT', 'Payment callback references disagree', 400)
  }
  return preOrderPaymentTransaction(candidates[0])
}

export async function processAuthorPreOrderAbaCallback(body, { signal } = {}) {
  const transaction = parseAuthorPreOrderCallbackTransaction(body)
  const { data: intent, error } = await supabase
    .from('author_preorder_payment_intents')
    .select('order_id,merchant_transaction_id')
    .eq('merchant_transaction_id', transaction)
    .maybeSingle()

  if (error) {
    console.error('PRE_ORDER_ABA_CALLBACK_INTENT_DB:', String(error.code || 'unknown'))
    throw preOrderError('PRE_ORDER_CALLBACK_INTENT_UNAVAILABLE', 'Payment callback cannot be verified', 503)
  }
  if (!intent || intent.merchant_transaction_id !== transaction) {
    throw preOrderError('PRE_ORDER_CALLBACK_INTENT_NOT_FOUND', 'Payment intent was not found', 404)
  }

  const orderId = preOrderPaymentId(intent.order_id, 'intent order ID')
  const settlement = await reconcileVerifiedHeldPreOrderPayment(orderId, { signal })
  if (settlement.verified !== true) {
    return { verified: false, notification_queued: false }
  }
  if (settlement.order_id !== orderId || ![true, false].includes(settlement.newly_paid)) {
    throw preOrderError('PRE_ORDER_CALLBACK_SETTLEMENT_INVALID', 'Payment settlement could not be confirmed', 503)
  }

  const queued = await queueVerifiedAuthorPreOrderPaidNotifications(orderId)
  if (!queued.queued || queued.recipient_jobs !== 2) {
    throw preOrderError('PRE_ORDER_CALLBACK_NOTIFICATION_UNAVAILABLE', 'Paid notifications were not queued', 503)
  }
  return { verified: true, notification_queued: true }
}
