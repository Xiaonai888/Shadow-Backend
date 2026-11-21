import { preOrderError, preOrderUuid } from './authorPreOrderValidation.service.js'
import { inspectAuthorPreOrderReconciliation } from './authorPreOrderReconciliationInspector.service.js'
import { recordPreOrderReconciliationEvent } from './authorPreOrderReconciliationAudit.service.js'
import { reconcileVerifiedHeldPreOrderPayment } from './authorPreOrderHeldPaymentFinalization.service.js'
import { reviewExpiredAuthorPreOrderHold } from './authorPreOrderPaymentExpiry.service.js'

const CODE = /^PRE_ORDER_[A-Z0-9_]{3,80}$/

function normalizeErrorCode(error) {
  const value = String(error?.code || '')
  return CODE.test(value) ? value : 'PRE_ORDER_RECONCILIATION_UNEXPECTED_FAILURE'
}

async function audit(orderId, outcome, code, kind = 'reconciliation') {
  try {
    await recordPreOrderReconciliationEvent({ orderId, kind, outcome, reasonCode: code })
    return true
  } catch (error) {
    console.error('PRE_ORDER_RECONCILIATION_AUDIT_MISSING:', normalizeErrorCode(error))
    return false
  }
}

export async function reconcileAuthorPreOrderOnce(orderId, { signal } = {}) {
  const id = preOrderUuid(orderId, 'order ID')
  if (signal?.aborted) throw preOrderError('PRE_ORDER_RECONCILIATION_ABORTED', 'Reconciliation was interrupted', 503)
  try {
    const inspection = await inspectAuthorPreOrderReconciliation(id)
    if (inspection.requires_manual_review) {
      const recorded = await audit(id, 'manual_review', inspection.issues[0])
      return { order_id: id, action: 'manual_review', code: inspection.issues[0], audit_recorded: recorded }
    }
    if (inspection.payment_status === 'paid') {
      const recorded = await audit(id, 'skipped', 'PRE_ORDER_RECON_ALREADY_PAID')
      return { order_id: id, action: 'already_paid', audit_recorded: recorded }
    }
    if (inspection.payment_status !== 'pending') {
      const recorded = await audit(id, 'skipped', 'PRE_ORDER_RECON_TERMINAL_ORDER')
      return { order_id: id, action: 'terminal_order', audit_recorded: recorded }
    }
    if (inspection.can_check_provider) {
      const result = await reconcileVerifiedHeldPreOrderPayment(id, { signal })
      if (result.verified === true) {
        const recorded = await audit(id, 'finalized', 'PRE_ORDER_RECON_PAYMENT_FINALIZED', 'finalization')
        return { order_id: id, action: 'payment_finalized', newly_paid: result.newly_paid === true, audit_recorded: recorded }
      }
      const code = CODE.test(result?.code || '') ? result.code : 'PRE_ORDER_RECON_PAYMENT_UNRESOLVED'
      const recorded = await audit(id, 'pending', code)
      return { order_id: id, action: 'provider_not_confirmed', code, audit_recorded: recorded }
    }
    if (inspection.hold_status === 'held' && inspection.hold_expired && !inspection.has_payment_intent) {
      const result = await reviewExpiredAuthorPreOrderHold(id, { signal })
      const released = result.released === true
      const recorded = await audit(id, released ? 'released' : 'pending', released ? 'PRE_ORDER_RECON_NO_INTENT_EXPIRED' : 'PRE_ORDER_RECON_EXPIRY_UNRESOLVED', 'expiry')
      return { order_id: id, action: released ? 'released_uninitialized_hold' : 'expiry_unresolved', released, audit_recorded: recorded }
    }
    const recorded = await audit(id, 'pending', 'PRE_ORDER_RECON_AWAITING_PAYMENT_INTENT')
    return { order_id: id, action: 'awaiting_payment_intent', audit_recorded: recorded }
  } catch (error) {
    await audit(id, 'failed', normalizeErrorCode(error))
    throw error
  }
}
