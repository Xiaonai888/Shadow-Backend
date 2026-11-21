import { supabase } from '../config/supabase.js'
import { preOrderError } from './authorPreOrderValidation.service.js'
import { preOrderPaymentId } from './authorPreOrderPaymentValidation.service.js'
import { parseAuthorPreOrderCallbackTransaction } from './authorPreOrderAbaCallback.service.js'
import { reconcileVerifiedMultiVolumePayment } from './authorPreOrderMultiVolumePayment.service.js'
import { queueVerifiedAuthorPreOrderPaidNotifications } from './authorPreOrderPaidNotification.service.js'

export async function processMultiVolumeAuthorPreOrderAbaCallback(body, { signal } = {}) {
  const transaction = parseAuthorPreOrderCallbackTransaction(body)
  const { data: intent, error } = await supabase.from('author_preorder_payment_intents')
    .select('order_id,merchant_transaction_id')
    .eq('merchant_transaction_id', transaction).maybeSingle()
  if (error) {
    console.error('PRE_ORDER_MULTI_CALLBACK_INTENT_DB:', String(error.code || 'unknown'))
    throw preOrderError('PRE_ORDER_MULTI_CALLBACK_UNAVAILABLE', 'Callback could not be verified', 503)
  }
  if (!intent || intent.merchant_transaction_id !== transaction) {
    throw preOrderError('PRE_ORDER_MULTI_CALLBACK_NOT_FOUND', 'Payment intent was not found', 404)
  }
  const id = preOrderPaymentId(intent.order_id)
  const settlement = await reconcileVerifiedMultiVolumePayment(id, { signal })
  if (settlement.verified !== true) {
    return { order_id: id, verified: false, notification_queued: false }
  }
  if (settlement.order_id !== id || ![true, false].includes(settlement.newly_paid)) {
    throw preOrderError('PRE_ORDER_MULTI_CALLBACK_RESULT_INVALID', 'Settlement result could not be verified', 503)
  }
  const queued = await queueVerifiedAuthorPreOrderPaidNotifications(id)
  if (!queued.queued || queued.recipient_jobs !== 2) {
    throw preOrderError('PRE_ORDER_MULTI_CALLBACK_NOTIFICATION_FAILED', 'Notification outbox is unavailable', 503)
  }
  return {
    order_id: id,
    verified: true,
    newly_paid: settlement.newly_paid === true,
    notification_queued: true,
  }
}
