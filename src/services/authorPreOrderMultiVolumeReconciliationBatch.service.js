import { preOrderError } from './authorPreOrderValidation.service.js'
import { listExpiredAuthorPreOrderMultiVolumeHolds } from './authorPreOrderMultiVolumePaymentExpiry.service.js'
import { reconcileAuthorPreOrderMultiVolumeOnce } from './authorPreOrderMultiVolumeReconciliationRunner.service.js'

const CODE = /^PRE_ORDER_[A-Z0-9_]{3,80}$/

export async function reconcileExpiredAuthorPreOrderMultiVolumeBatch({ limit = 10, signal } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10) {
    throw preOrderError('PRE_ORDER_MULTI_RECON_BATCH_INVALID', 'Batch size must be between 1 and 10', 400)
  }
  if (signal?.aborted) {
    throw preOrderError('PRE_ORDER_MULTI_RECON_ABORTED', 'Reconciliation was interrupted', 503)
  }
  const { orders, possible_more: possibleMore } = await listExpiredAuthorPreOrderMultiVolumeHolds({ limit })
  const results = []
  for (const { order_id: orderId } of orders) {
    if (signal?.aborted) {
      throw preOrderError('PRE_ORDER_MULTI_RECON_ABORTED', 'Reconciliation was interrupted', 503)
    }
    try {
      results.push(await reconcileAuthorPreOrderMultiVolumeOnce(orderId, { signal }))
    } catch (error) {
      const raw = String(error?.code || '')
      results.push({
        order_id: orderId,
        action: 'manual_review',
        code: CODE.test(raw) ? raw : 'PRE_ORDER_MULTI_RECON_UNEXPECTED',
      })
    }
  }
  return {
    checked: results.length,
    paid_finalized: results.filter(row => row.action === 'payment_finalized').length,
    uninitialized_holds_released: results.filter(row => row.action === 'released_uninitialized_hold').length,
    needs_review: results.filter(row => ['manual_review', 'provider_review_required', 'provider_not_confirmed'].includes(row.action)).length,
    results,
    possible_more: possibleMore,
    executed_once: true,
    recurring_worker_started: false,
  }
}
