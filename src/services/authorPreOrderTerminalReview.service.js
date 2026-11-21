import { supabase } from '../config/supabase.js'
import { preOrderError, preOrderUuid } from './authorPreOrderValidation.service.js'
import { getAuthorPreOrderStockHold } from './authorPreOrderStockHold.service.js'
import { getAuthorPreOrderPaymentIntent } from './authorPreOrderPaymentIntent.service.js'
import { verifyAuthorPreOrderPayWaySettlement } from './authorPreOrderPayWayVerification.service.js'
import { reconcileVerifiedHeldPreOrderPayment } from './authorPreOrderHeldPaymentFinalization.service.js'
import { assessExpiredPreOrderPayment } from './authorPreOrderTerminalPolicy.service.js'

function databaseFailure(error) {
  if (!error) return
  console.error('PRE_ORDER_TERMINAL_REVIEW_STORAGE:', String(error.code || 'unknown'))
  throw preOrderError('PRE_ORDER_TERMINAL_REVIEW_UNAVAILABLE', 'Could not record payment review', 503)
}

export async function reviewExpiredPreOrderPayment(orderId, { signal } = {}) {
  const id = preOrderUuid(orderId, 'order ID')
  const hold = await getAuthorPreOrderStockHold(id)
  if (hold.status !== 'held') {
    return { order_id: id, action: 'already_resolved', release_allowed: false }
  }
  if (Date.parse(String(hold.expires_at || '')) > Date.now()) {
    return { order_id: id, action: 'not_expired', release_allowed: false }
  }
  let intent
  try {
    intent = await getAuthorPreOrderPaymentIntent(id)
  } catch (error) {
    if (error.code === 'PRE_ORDER_PAYMENT_INTENT_NOT_FOUND') {
      return { order_id: id, action: 'no_payment_intent', release_allowed: false }
    }
    throw error
  }
  const settlement = await verifyAuthorPreOrderPayWaySettlement(intent, { signal })
  const assessment = assessExpiredPreOrderPayment(intent, hold, settlement)
  if (assessment.action === 'finalize_paid') {
    const result = await reconcileVerifiedHeldPreOrderPayment(id, { signal })
    return { order_id: id, action: 'payment_reconciliation', release_allowed: false, ...result }
  }
  const observation = String(settlement.code || 'PRE_ORDER_PAYWAY_UNRESOLVED')
  if (!/^PRE_ORDER_[A-Z0-9_]{3,80}$/.test(observation)) {
    throw preOrderError('PRE_ORDER_TERMINAL_REVIEW_INVALID', 'Payment review status is invalid', 503)
  }
  const { data, error } = await supabase.rpc('author_preorder_record_terminal_review', {
    p_order_id: id,
    p_transaction_id: intent.merchant_transaction_id,
    p_observation: observation,
  })
  databaseFailure(error)
  if (data?.order_id !== id || !Number.isSafeInteger(Number(data?.review_count)) || Number(data.review_count) < 1) {
    throw preOrderError('PRE_ORDER_TERMINAL_REVIEW_INVALID', 'Payment review was not recorded', 503)
  }
  return {
    order_id: id,
    action: assessment.action,
    release_allowed: false,
    review_count: Number(data.review_count),
    provider_observation: observation,
  }
}
