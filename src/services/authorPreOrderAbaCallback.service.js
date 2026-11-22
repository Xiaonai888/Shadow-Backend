import { supabase } from '../config/supabase.js'
import { preOrderError } from './authorPreOrderValidation.service.js'
import { preOrderPaymentTransaction, preOrderPaymentId } from './authorPreOrderPaymentValidation.service.js'
import { reconcileVerifiedHeldPreOrderPayment } from './authorPreOrderHeldPaymentFinalization.service.js'
import { reconcileVerifiedMultiVolumePayment } from './authorPreOrderMultiVolumePayment.service.js'
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

async function resolveVerifiedOrderHoldType(orderId) {
  const [volumeResult, legacyResult] = await Promise.all([
    supabase.from('author_preorder_volume_holds')
      .select('book_id,edition,quantity,status')
      .eq('order_id', orderId).limit(11),
    supabase.from('author_preorder_stock_holds')
      .select('order_id,status')
      .eq('order_id', orderId).limit(2),
  ])
  if (volumeResult.error || legacyResult.error) {
    console.error('PRE_ORDER_CALLBACK_HOLD_LOOKUP_FAILED:',
      String(volumeResult.error?.code || legacyResult.error?.code || 'unknown'))
    throw preOrderError('PRE_ORDER_CALLBACK_HOLD_UNAVAILABLE', 'Payment stock holds could not be inspected', 503)
  }
  const volumes = volumeResult.data
  const legacy = legacyResult.data
  if (!Array.isArray(volumes) || !Array.isArray(legacy)) {
    throw preOrderError('PRE_ORDER_CALLBACK_HOLD_INVALID', 'Payment stock holds are invalid', 503)
  }
  if (volumes.length >= 1 && volumes.length <= 10 && legacy.length === 0 &&
      volumes.every(row => ['held', 'consumed'].includes(row.status))) {
    return 'multi_volume'
  }
  if (volumes.length === 0 && legacy.length === 1 &&
      ['held', 'consumed'].includes(legacy[0].status)) {
    return 'legacy'
  }
  throw preOrderError('PRE_ORDER_CALLBACK_HOLD_MISMATCH', 'Payment requires a manual hold review', 409)
}

export async function processAuthorPreOrderAbaCallback(body, { signal } = {}) {
  if (signal?.aborted) {
    throw preOrderError('PRE_ORDER_CALLBACK_ABORTED', 'Payment callback was interrupted', 503)
  }
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
  const holdType = await resolveVerifiedOrderHoldType(orderId)
  const settlement = holdType === 'multi_volume'
    ? await reconcileVerifiedMultiVolumePayment(orderId, { signal })
    : await reconcileVerifiedHeldPreOrderPayment(orderId, { signal })

  if (!settlement || settlement.order_id !== orderId ||
      typeof settlement.verified !== 'boolean' ||
      typeof settlement.newly_paid !== 'boolean') {
    throw preOrderError('PRE_ORDER_CALLBACK_SETTLEMENT_INVALID', 'Payment settlement could not be confirmed', 503)
  }
  if (!settlement.verified) {
    return { verified: false, notification_queued: false }
  }

  const queued = await queueVerifiedAuthorPreOrderPaidNotifications(orderId)
  if (!queued?.queued || queued.order_id !== orderId || queued.recipient_jobs !== 2) {
    throw preOrderError('PRE_ORDER_CALLBACK_NOTIFICATION_UNAVAILABLE', 'Paid notifications were not queued', 503)
  }
  return { verified: true, notification_queued: true }
}
