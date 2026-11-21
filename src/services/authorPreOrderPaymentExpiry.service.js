import { supabase } from '../config/supabase.js'
import { preOrderError, preOrderUuid } from './authorPreOrderValidation.service.js'
import { getAuthorPreOrderPaymentIntent } from './authorPreOrderPaymentIntent.service.js'
import { verifyAuthorPreOrderPayWaySettlement } from './authorPreOrderPayWayVerification.service.js'
import { reconcileVerifiedHeldPreOrderPayment } from './authorPreOrderHeldPaymentFinalization.service.js'
import { getAuthorPreOrderStockHold } from './authorPreOrderStockHold.service.js'

function failed(error, scope) {
  const code = String(error?.message || '').match(/PRE_ORDER_[A-Z0-9_]+/)?.[0]
  if (code) throw preOrderError(code, 'Expired pre-order inventory could not be released automatically', 409)
  console.error(`PRE_ORDER_EXPIRY_${scope}:`, String(error?.code || 'unknown'))
  throw preOrderError('PRE_ORDER_EXPIRY_STORAGE_UNAVAILABLE', 'Could not inspect expired pre-order holds', 503)
}

export async function listExpiredAuthorPreOrderHolds({ limit = 50 } = {}) {
  const max = Number(limit)
  if (!Number.isSafeInteger(max) || max < 1 || max > 100) {
    throw preOrderError('PRE_ORDER_EXPIRY_LIMIT_INVALID', 'Invalid expiry batch size', 400)
  }
  const { data, error } = await supabase.from('author_preorder_stock_holds')
    .select('order_id,expires_at')
    .eq('status', 'held')
    .lte('expires_at', new Date().toISOString())
    .order('expires_at', { ascending: true })
    .limit(max)
  if (error) failed(error, 'LIST')
  return data || []
}

export async function reviewExpiredAuthorPreOrderHold(orderId, { signal } = {}) {
  const id = preOrderUuid(orderId, 'order ID')
  const hold = await getAuthorPreOrderStockHold(id)
  if (hold.status !== 'held') {
    return { order_id: id, action: 'already_resolved', released: hold.status === 'released' }
  }
  if (Date.parse(String(hold.expires_at || '')) > Date.now()) {
    return { order_id: id, action: 'not_expired', released: false }
  }

  let intent
  try {
    intent = await getAuthorPreOrderPaymentIntent(id)
  } catch (error) {
    if (error?.code !== 'PRE_ORDER_PAYMENT_INTENT_NOT_FOUND') throw error
  }

  if (!intent) {
    const { data, error } = await supabase.rpc('author_preorder_release_uninitialized_expired_hold', {
      p_order_id: id,
    })
    if (error) failed(error, 'RELEASE_NO_INTENT')
    if (data?.order_id !== id || data?.released !== true) {
      throw preOrderError('PRE_ORDER_EXPIRY_RESULT_INVALID', 'Expiry release was not confirmed', 503)
    }
    return { order_id: id, action: 'released_without_payment_intent', released: true }
  }

  const verified = await verifyAuthorPreOrderPayWaySettlement(intent, { signal })
  if (verified.confirmed === true) {
    const outcome = await reconcileVerifiedHeldPreOrderPayment(id, { signal })
    return { order_id: id, action: 'payment_verified', released: false, ...outcome }
  }

  return {
    order_id: id,
    action: 'provider_terminal_confirmation_required',
    released: false,
    code: 'PRE_ORDER_EXPIRY_PAYMENT_UNRESOLVED',
  }
}
