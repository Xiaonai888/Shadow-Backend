import { supabase } from '../config/supabase.js'
import { preOrderError, preOrderUuid } from './authorPreOrderValidation.service.js'
import { getAuthorPreOrderMultiVolumeHolds } from './authorPreOrderMultiVolumeHold.service.js'
import { getAuthorPreOrderPaymentIntent } from './authorPreOrderPaymentIntent.service.js'
import {
  reconcileVerifiedMultiVolumePayment,
  releaseUninitializedExpiredMultiVolumeHold,
} from './authorPreOrderMultiVolumePayment.service.js'

const CODE = /^PRE_ORDER_[A-Z0-9_]+$/

export async function reviewExpiredMultiVolumeHold(orderId, { signal } = {}) {
  const id = preOrderUuid(orderId, 'order ID').toLowerCase()
  if (signal?.aborted) throw preOrderError('PRE_ORDER_MULTI_EXPIRY_ABORTED', 'Expiry review interrupted', 503)
  const holds = await getAuthorPreOrderMultiVolumeHolds(id)
  if (holds.some(hold => hold.status !== 'held')) {
    return { order_id: id, action: 'already_resolved', released: false }
  }
  const expiry = Math.max(...holds.map(hold => Date.parse(String(hold.expires_at || ''))))
  if (!Number.isFinite(expiry)) {
    throw preOrderError('PRE_ORDER_MULTI_EXPIRY_INVALID', 'Invalid stock hold expiry', 503)
  }
  if (expiry > Date.now()) return { order_id: id, action: 'not_expired', released: false }

  let intent
  try {
    intent = await getAuthorPreOrderPaymentIntent(id)
  } catch (error) {
    if (error?.code !== 'PRE_ORDER_PAYMENT_INTENT_NOT_FOUND') throw error
  }
  if (!intent) {
    const result = await releaseUninitializedExpiredMultiVolumeHold(id)
    return { order_id: id, action: 'released_without_payment_intent', released: result.released }
  }
  const settlement = await reconcileVerifiedMultiVolumePayment(id, { signal })
  if (settlement.verified === true) {
    return { order_id: id, action: 'payment_finalized', released: false, newly_paid: settlement.newly_paid === true }
  }
  return {
    order_id: id,
    action: 'provider_terminal_evidence_required',
    released: false,
    code: 'PRE_ORDER_MULTI_EXPIRY_UNRESOLVED',
  }
}

export async function reviewExpiredMultiVolumeHoldsBatch({ limit = 10, signal } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) {
    throw preOrderError('PRE_ORDER_MULTI_EXPIRY_LIMIT_INVALID', 'Invalid expiry review batch size', 400)
  }
  const { data, error } = await supabase.from('author_preorder_volume_holds')
    .select('order_id,expires_at')
    .eq('status', 'held')
    .lte('expires_at', new Date().toISOString())
    .order('expires_at', { ascending: true })
    .limit(Math.min(100, limit * 10))
  if (error) {
    console.error('PRE_ORDER_MULTI_EXPIRY_LIST_DB:', String(error.code || 'unknown'))
    throw preOrderError('PRE_ORDER_MULTI_EXPIRY_UNAVAILABLE', 'Could not load expired holds', 503)
  }
  const unique = [...new Set((data || []).map(item => String(item.order_id).toLowerCase()))].slice(0, limit)
  const results = []
  for (const id of unique) {
    if (signal?.aborted) throw preOrderError('PRE_ORDER_MULTI_EXPIRY_ABORTED', 'Expiry review interrupted', 503)
    try {
      results.push(await reviewExpiredMultiVolumeHold(id, { signal }))
    } catch (cause) {
      const code = String(cause?.code || '')
      results.push({
        order_id: id,
        action: 'manual_review_required',
        released: false,
        code: CODE.test(code) ? code : 'PRE_ORDER_MULTI_EXPIRY_REVIEW_FAILED',
      })
    }
  }
  return {
    reviewed: results.length,
    released_without_intent: results.filter(row => row.action === 'released_without_payment_intent' && row.released).length,
    finalized: results.filter(row => row.action === 'payment_finalized').length,
    results,
    possible_more: (data || []).length >= Math.min(100, limit * 10),
  }
}
