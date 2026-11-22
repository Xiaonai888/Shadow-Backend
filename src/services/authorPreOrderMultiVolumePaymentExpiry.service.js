import { supabase } from '../config/supabase.js'
import { preOrderError, preOrderUuid } from './authorPreOrderValidation.service.js'
import { inspectAuthorPreOrderMultiVolumeReconciliation } from './authorPreOrderMultiVolumeReconciliationInspector.service.js'
import {
  reconcileVerifiedMultiVolumePayment,
  releaseUninitializedExpiredMultiVolumeHold,
} from './authorPreOrderMultiVolumePayment.service.js'

export async function listExpiredAuthorPreOrderMultiVolumeHolds({ limit = 10 } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10) {
    throw preOrderError('PRE_ORDER_MULTI_EXPIRY_LIMIT_INVALID', 'Expiry batch size must be 1 to 10', 400)
  }
  const { data, error } = await supabase.from('author_preorder_volume_holds')
    .select('order_id,expires_at')
    .eq('status', 'held')
    .lte('expires_at', new Date().toISOString())
    .order('expires_at', { ascending: true })
    .limit(100)
  if (error) {
    console.error('PRE_ORDER_MULTI_EXPIRY_LIST_DB:', String(error.code || 'unknown'))
    throw preOrderError('PRE_ORDER_MULTI_EXPIRY_LIST_UNAVAILABLE', 'Could not find expired volume holds', 503)
  }
  if (!Array.isArray(data)) {
    throw preOrderError('PRE_ORDER_MULTI_EXPIRY_LIST_INVALID', 'Expiry query was invalid', 503)
  }
  const seen = new Set()
  const orders = []
  for (const row of data) {
    const id = preOrderUuid(row?.order_id, 'expired order ID').toLowerCase()
    if (!seen.has(id)) {
      seen.add(id)
      orders.push({ order_id: id, expires_at: row.expires_at })
      if (orders.length >= limit) break
    }
  }
  return { orders, possible_more: data.length === 100 || orders.length === limit }
}

export async function reviewExpiredAuthorPreOrderMultiVolumeHold(orderId, { signal } = {}) {
  const id = preOrderUuid(orderId, 'order ID').toLowerCase()
  if (signal?.aborted) {
    throw preOrderError('PRE_ORDER_MULTI_EXPIRY_ABORTED', 'Payment review was interrupted', 503)
  }
  const inspection = await inspectAuthorPreOrderMultiVolumeReconciliation(id)
  if (inspection.requires_manual_review) {
    return {
      order_id: id,
      action: 'manual_review',
      code: inspection.issues[0],
      released: false,
    }
  }
  if (inspection.payment_status !== 'pending' || inspection.hold_status !== 'held') {
    return { order_id: id, action: 'already_resolved', released: inspection.hold_status === 'released' }
  }
  if (!inspection.hold_expired) {
    return { order_id: id, action: 'not_expired', released: false }
  }
  if (!inspection.has_payment_intent) {
    if (!inspection.can_release_without_intent) {
      return { order_id: id, action: 'manual_review', code: 'PRE_ORDER_MULTI_EXPIRY_RELEASE_BLOCKED', released: false }
    }
    const result = await releaseUninitializedExpiredMultiVolumeHold(id)
    return {
      order_id: id,
      action: 'released_without_payment_intent',
      released: result.released === true,
      reused: result.reused,
    }
  }
  if (!inspection.can_check_provider) {
    return { order_id: id, action: 'manual_review', code: 'PRE_ORDER_MULTI_EXPIRY_PROVIDER_CHECK_BLOCKED', released: false }
  }
  const result = await reconcileVerifiedMultiVolumePayment(id, { signal })
  if (result.verified === true) {
    return { ...result, order_id: id, action: 'payment_finalized', released: false }
  }
  return {
    order_id: id,
    action: 'provider_review_required',
    code: /^PRE_ORDER_[A-Z0-9_]{3,80}$/.test(String(result.code || ''))
      ? result.code : 'PRE_ORDER_MULTI_EXPIRY_PAYMENT_UNRESOLVED',
    released: false,
  }
}
