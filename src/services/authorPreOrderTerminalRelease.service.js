import { supabase } from '../config/supabase.js'
import { preOrderError, preOrderUuid } from './authorPreOrderValidation.service.js'
import { getAuthorPreOrderPaymentIntent } from './authorPreOrderPaymentIntent.service.js'
import { verifyAuthorPreOrderPayWaySettlement } from './authorPreOrderPayWayVerification.service.js'
import { reconcileVerifiedHeldPreOrderPayment } from './authorPreOrderHeldPaymentFinalization.service.js'
import { validateManualTerminalAttestation } from './authorPreOrderTerminalPolicy.service.js'

export async function releaseManuallyVerifiedTerminalPreOrder(orderId, staffUserId, attestation, { signal } = {}) {
  const id = preOrderUuid(orderId, 'order ID')
  const staff = preOrderUuid(staffUserId, 'verified staff user ID')
  const proof = validateManualTerminalAttestation(attestation)
  const intent = await getAuthorPreOrderPaymentIntent(id)
  if (intent.finalized_at) {
    throw preOrderError('PRE_ORDER_TERMINAL_ALREADY_FINALIZED', 'Payment was already finalized', 409)
  }
  const settlement = await verifyAuthorPreOrderPayWaySettlement(intent, { signal })
  if (settlement.confirmed === true) {
    await reconcileVerifiedHeldPreOrderPayment(id, { signal })
    throw preOrderError('PRE_ORDER_TERMINAL_PAYMENT_APPROVED', 'Verified payment cannot be released as unpaid', 409)
  }
  if (settlement.confirmed !== false) {
    throw preOrderError('PRE_ORDER_TERMINAL_PROVIDER_UNCERTAIN', 'Provider payment status is uncertain', 409)
  }
  const { data, error } = await supabase.rpc('author_preorder_release_verified_terminal_hold', {
    p_order_id: id,
    p_transaction_id: intent.merchant_transaction_id,
    p_staff_user_id: staff,
    p_provider_terminal_status: proof.provider_terminal_status,
    p_evidence_reference: proof.evidence_reference,
    p_verified_at: proof.verified_at,
  })
  if (error) {
    const code = String(error.message || '').match(/PRE_ORDER_[A-Z0-9_]+/)?.[0]
    if (code) throw preOrderError(code, 'Stock release was rejected; keep order under review', 409)
    console.error('PRE_ORDER_TERMINAL_RELEASE_STORAGE:', String(error.code || 'unknown'))
    throw preOrderError('PRE_ORDER_TERMINAL_RELEASE_UNAVAILABLE', 'Stock release could not be completed', 503)
  }
  if (data?.order_id !== id || data?.released !== true) {
    throw preOrderError('PRE_ORDER_TERMINAL_RELEASE_INVALID', 'Stock release was not confirmed', 503)
  }
  return { order_id: id, released: true, reused: data.reused === true }
}
