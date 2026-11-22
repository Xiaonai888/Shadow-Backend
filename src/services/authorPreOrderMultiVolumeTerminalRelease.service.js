import { supabase } from '../config/supabase.js'
import { preOrderError, preOrderUuid } from './authorPreOrderValidation.service.js'
import { validateManualTerminalAttestation } from './authorPreOrderTerminalPolicy.service.js'
import { getAuthorPreOrderPaymentIntent } from './authorPreOrderPaymentIntent.service.js'
import { verifyAuthorPreOrderPayWaySettlement } from './authorPreOrderPayWayVerification.service.js'
import { reconcileVerifiedMultiVolumePayment } from './authorPreOrderMultiVolumePayment.service.js'
import { queueVerifiedAuthorPreOrderPaidNotifications } from './authorPreOrderPaidNotification.service.js'
import { inspectAuthorPreOrderMultiVolumeTerminalPreflight } from './authorPreOrderMultiVolumeTerminalPreflight.service.js'
import { requireAuthorPreOrderMultiVolumeTerminalManualEnabled } from './authorPreOrderMultiVolumeTerminalPolicy.service.js'

export async function releaseManuallyVerifiedMultiVolumeTerminalPreOrder(
  orderId, staffUserId, attestation, { signal, staffAuthorization } = {}
) {
  requireAuthorPreOrderMultiVolumeTerminalManualEnabled()
  const id = preOrderUuid(orderId, 'order ID').toLowerCase()
  const staff = preOrderUuid(staffUserId, 'verified staff user ID').toLowerCase()
  if (!staffAuthorization || staffAuthorization.authorized !== true ||
      staffAuthorization.staff_user_id !== staff ||
      staffAuthorization.scope !== 'preorder:release-terminal-hold') {
    throw preOrderError('PRE_ORDER_MULTI_TERMINAL_STAFF_FORBIDDEN', 'Verified staff authorization is required', 403)
  }
  if (signal?.aborted) {
    throw preOrderError('PRE_ORDER_MULTI_TERMINAL_ABORTED', 'Terminal release was interrupted', 503)
  }
  const proof = validateManualTerminalAttestation(attestation)
  const preflight = await inspectAuthorPreOrderMultiVolumeTerminalPreflight(id)
  if (preflight.ready_for_terminal_proof !== true) {
    throw preOrderError(preflight.code, 'Multi-volume stock release is not yet eligible', 409)
  }
  if (Date.parse(proof.verified_at) < Date.parse(preflight.hold_expires_at)) {
    throw preOrderError('PRE_ORDER_MULTI_TERMINAL_EVIDENCE_PREMATURE', 'Provider evidence predates the hold expiry', 409)
  }
  const intent = await getAuthorPreOrderPaymentIntent(id)
  if (intent.finalized_at || Date.parse(proof.verified_at) < Date.parse(intent.expires_at)) {
    throw preOrderError('PRE_ORDER_MULTI_TERMINAL_INTENT_NOT_READY', 'Payment intent is not eligible for release', 409)
  }
  const settlement = await verifyAuthorPreOrderPayWaySettlement(intent, { signal })
  if (settlement.confirmed === true) {
    const paid = await reconcileVerifiedMultiVolumePayment(id, { signal })
    if (paid.verified === true) {
      await queueVerifiedAuthorPreOrderPaidNotifications(id)
    }
    throw preOrderError('PRE_ORDER_MULTI_TERMINAL_PAYMENT_APPROVED', 'Paid inventory cannot be released as unpaid', 409)
  }
  if (settlement.confirmed !== false) {
    throw preOrderError('PRE_ORDER_MULTI_TERMINAL_PROVIDER_UNCERTAIN', 'Provider payment status is uncertain', 409)
  }
  const { data, error } = await supabase.rpc('author_preorder_release_verified_multivolume_terminal_hold', {
    p_order_id: id,
    p_transaction_id: intent.merchant_transaction_id,
    p_staff_user_id: staff,
    p_provider_terminal_status: proof.provider_terminal_status,
    p_evidence_reference: proof.evidence_reference,
    p_verified_at: proof.verified_at,
  })
  if (error) {
    const code = String(error.message || '').match(/PRE_ORDER_[A-Z0-9_]+/)?.[0]
    if (code) throw preOrderError(code, 'Manual terminal release requires further review', 409)
    console.error('PRE_ORDER_MULTI_TERMINAL_RELEASE_DB:', String(error.code || 'unknown'))
    throw preOrderError('PRE_ORDER_MULTI_TERMINAL_RELEASE_UNAVAILABLE', 'Terminal release could not be confirmed', 503)
  }
  if (!data || String(data.order_id).toLowerCase() !== id || data.released !== true ||
      typeof data.reused !== 'boolean' ||
      !Number.isSafeInteger(Number(data.item_count)) ||
      Number(data.item_count) !== preflight.item_count) {
    throw preOrderError('PRE_ORDER_MULTI_TERMINAL_RELEASE_UNCONFIRMED', 'Terminal release response is inconsistent', 503)
  }
  return { order_id: id, released: true, reused: data.reused, item_count: Number(data.item_count), manual_release: true }
}
