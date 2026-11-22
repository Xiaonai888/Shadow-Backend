import { preOrderError, preOrderUuid } from './authorPreOrderValidation.service.js'
import { inspectAuthorPreOrderMultiVolumeReconciliation } from './authorPreOrderMultiVolumeReconciliationInspector.service.js'
import { reconcileVerifiedMultiVolumePayment } from './authorPreOrderMultiVolumePayment.service.js'
import { reviewExpiredAuthorPreOrderMultiVolumeHold } from './authorPreOrderMultiVolumePaymentExpiry.service.js'
import { queueVerifiedAuthorPreOrderPaidNotifications } from './authorPreOrderPaidNotification.service.js'
import { recordPreOrderReconciliationEvent } from './authorPreOrderReconciliationAudit.service.js'

const CODE = /^PRE_ORDER_[A-Z0-9_]{3,80}$/

function normalizedCode(error) {
  const code = String(error?.code || '')
  return CODE.test(code) ? code : 'PRE_ORDER_MULTI_RECON_UNEXPECTED'
}

async function record(orderId, kind, outcome, code) {
  try {
    await recordPreOrderReconciliationEvent({
      orderId, kind, outcome, reasonCode: code,
    })
    return true
  } catch (error) {
    console.error('PRE_ORDER_MULTI_RECON_AUDIT_FAILED:', normalizedCode(error))
    return false
  }
}

async function ensureNotifications(orderId) {
  const result = await queueVerifiedAuthorPreOrderPaidNotifications(orderId)
  if (result?.queued !== true || result.recipient_jobs !== 2 ||
      result.order_id !== orderId) {
    throw preOrderError('PRE_ORDER_MULTI_RECON_NOTIFY_UNCONFIRMED', 'Paid notification queue was not confirmed', 503)
  }
  return true
}

export async function reconcileAuthorPreOrderMultiVolumeOnce(orderId, { signal } = {}) {
  const id = preOrderUuid(orderId, 'order ID').toLowerCase()
  if (signal?.aborted) {
    throw preOrderError('PRE_ORDER_MULTI_RECON_ABORTED', 'Reconciliation was interrupted', 503)
  }
  try {
    const inspection = await inspectAuthorPreOrderMultiVolumeReconciliation(id)
    if (inspection.requires_manual_review) {
      const code = inspection.issues[0]
      const auditRecorded = await record(id, 'review', 'manual_review', code)
      return { order_id: id, action: 'manual_review', code, audit_recorded: auditRecorded }
    }
    if (inspection.payment_status === 'paid') {
      await ensureNotifications(id)
      const auditRecorded = await record(id, 'reconciliation', 'skipped', 'PRE_ORDER_MULTI_RECON_ALREADY_PAID')
      return { order_id: id, action: 'already_paid', notification_queued: true, audit_recorded: auditRecorded }
    }
    if (inspection.payment_status !== 'pending') {
      const auditRecorded = await record(id, 'reconciliation', 'skipped', 'PRE_ORDER_MULTI_RECON_TERMINAL_ORDER')
      return { order_id: id, action: 'terminal_order', audit_recorded: auditRecorded }
    }
    if (inspection.hold_expired) {
      const outcome = await reviewExpiredAuthorPreOrderMultiVolumeHold(id, { signal })
      if (outcome.action === 'payment_finalized') {
        await ensureNotifications(id)
        const auditRecorded = await record(id, 'finalization', 'finalized', 'PRE_ORDER_MULTI_RECON_PAYMENT_FINALIZED')
        return { order_id: id, action: 'payment_finalized', notification_queued: true,
          newly_paid: outcome.newly_paid === true, audit_recorded: auditRecorded }
      }
      if (outcome.action === 'released_without_payment_intent') {
        const auditRecorded = await record(id, 'expiry', 'released', 'PRE_ORDER_MULTI_RECON_NO_INTENT_EXPIRED')
        return { order_id: id, action: 'released_uninitialized_hold', released: true, audit_recorded: auditRecorded }
      }
      const action = outcome.action === 'provider_review_required' ? 'provider_review_required' : 'manual_review'
      const code = CODE.test(String(outcome.code || '')) ? outcome.code : 'PRE_ORDER_MULTI_RECON_EXPIRY_UNRESOLVED'
      const auditRecorded = await record(id, 'review', action === 'manual_review' ? 'manual_review' : 'pending', code)
      return { order_id: id, action, code, audit_recorded: auditRecorded }
    }
    if (inspection.can_check_provider) {
      const outcome = await reconcileVerifiedMultiVolumePayment(id, { signal })
      if (outcome.verified === true) {
        await ensureNotifications(id)
        const auditRecorded = await record(id, 'finalization', 'finalized', 'PRE_ORDER_MULTI_RECON_PAYMENT_FINALIZED')
        return { order_id: id, action: 'payment_finalized', notification_queued: true,
          newly_paid: outcome.newly_paid === true, audit_recorded: auditRecorded }
      }
      const code = CODE.test(String(outcome.code || '')) ? outcome.code : 'PRE_ORDER_MULTI_RECON_PAYMENT_UNRESOLVED'
      const auditRecorded = await record(id, 'reconciliation', 'pending', code)
      return { order_id: id, action: 'provider_not_confirmed', code, audit_recorded: auditRecorded }
    }
    const auditRecorded = await record(id, 'reconciliation', 'pending', 'PRE_ORDER_MULTI_RECON_AWAITING_PAYMENT_INTENT')
    return { order_id: id, action: 'awaiting_payment_intent', audit_recorded: auditRecorded }
  } catch (error) {
    await record(id, 'reconciliation', 'failed', normalizedCode(error))
    throw error
  }
}
