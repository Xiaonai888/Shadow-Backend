import { supabase } from '../config/supabase.js'
import { preOrderError, preOrderUuid } from './authorPreOrderValidation.service.js'
import { inspectAuthorPreOrderMultiVolumeReconciliation } from './authorPreOrderMultiVolumeReconciliationInspector.service.js'
import { getAuthorPreOrderPaymentIntent } from './authorPreOrderPaymentIntent.service.js'
import { verifyAuthorPreOrderPayWaySettlement } from './authorPreOrderPayWayVerification.service.js'
import { reconcileVerifiedMultiVolumePayment } from './authorPreOrderMultiVolumePayment.service.js'
import { queueVerifiedAuthorPreOrderPaidNotifications } from './authorPreOrderPaidNotification.service.js'
import { requireAuthorPreOrderMultiVolumeTerminalManualEnabled } from './authorPreOrderMultiVolumeTerminalPolicy.service.js'

const CODE = /^PRE_ORDER_[A-Z0-9_]{3,80}$/

export async function reviewAuthorPreOrderMultiVolumeTerminalOnce(orderId, { signal, staffAuthorization } = {}) {
  requireAuthorPreOrderMultiVolumeTerminalManualEnabled()
  if (!staffAuthorization || staffAuthorization.authorized !== true ||
      staffAuthorization.scope !== 'preorder:review-terminal-hold') {
    throw preOrderError('PRE_ORDER_MULTI_TERMINAL_STAFF_FORBIDDEN', 'Verified staff authorization is required', 403)
  }
  if (signal?.aborted) {
    throw preOrderError('PRE_ORDER_MULTI_TERMINAL_ABORTED', 'Payment terminal review was interrupted', 503)
  }
  const id = preOrderUuid(orderId, 'order ID').toLowerCase()
  const inspection = await inspectAuthorPreOrderMultiVolumeReconciliation(id)
  if (inspection.requires_manual_review || inspection.hold_type !== 'multi_volume' ||
      inspection.payment_status !== 'pending' || inspection.hold_status !== 'held' ||
      !inspection.hold_expired || !inspection.has_payment_intent) {
    throw preOrderError('PRE_ORDER_MULTI_TERMINAL_REVIEW_NOT_READY', 'This order is not eligible for terminal review', 409)
  }
  const intent = await getAuthorPreOrderPaymentIntent(id)
  if (intent.finalized_at) {
    throw preOrderError('PRE_ORDER_MULTI_TERMINAL_ALREADY_FINALIZED', 'Payment intent was already finalized', 409)
  }
  const settlement = await verifyAuthorPreOrderPayWaySettlement(intent, { signal })
  if (settlement.confirmed === true) {
    const paid = await reconcileVerifiedMultiVolumePayment(id, { signal })
    if (paid.verified !== true || paid.order_id !== id) {
      throw preOrderError('PRE_ORDER_MULTI_TERMINAL_PAID_NOT_CONFIRMED', 'Paid order was not finalized', 503)
    }
    const queued = await queueVerifiedAuthorPreOrderPaidNotifications(id)
    if (queued?.queued !== true || queued.order_id !== id || queued.recipient_jobs !== 2) {
      throw preOrderError('PRE_ORDER_MULTI_TERMINAL_NOTIFY_UNAVAILABLE', 'Paid notifications were not queued', 503)
    }
    return { order_id: id, action: 'payment_finalized', stock_released: false, payment_verified: true, notification_queued: true }
  }
  if (settlement.confirmed !== false || !CODE.test(String(settlement.code || ''))) {
    throw preOrderError('PRE_ORDER_MULTI_TERMINAL_PROVIDER_UNKNOWN', 'Provider status requires manual investigation', 409)
  }
  const { data, error } = await supabase.rpc('author_preorder_record_terminal_review', {
    p_order_id: id,
    p_transaction_id: intent.merchant_transaction_id,
    p_observation: settlement.code,
  })
  if (error) {
    const code = String(error.message || '').match(/PRE_ORDER_[A-Z0-9_]+/)?.[0]
    if (code) throw preOrderError(code, 'Terminal review could not be recorded', 409)
    console.error('PRE_ORDER_MULTI_TERMINAL_REVIEW_DB:', String(error.code || 'unknown'))
    throw preOrderError('PRE_ORDER_MULTI_TERMINAL_REVIEW_UNAVAILABLE', 'Terminal review storage is unavailable', 503)
  }
  if (!data || String(data.order_id).toLowerCase() !== id ||
      !Number.isSafeInteger(Number(data.review_count)) || Number(data.review_count) < 1) {
    throw preOrderError('PRE_ORDER_MULTI_TERMINAL_REVIEW_UNCONFIRMED', 'Provider observation was not recorded', 503)
  }
  return {
    order_id: id,
    action: 'provider_terminal_evidence_required',
    review_count: Number(data.review_count),
    provider_observation: settlement.code,
    payment_verified: false,
    stock_released: false,
    automatic_release: false,
  }
}
