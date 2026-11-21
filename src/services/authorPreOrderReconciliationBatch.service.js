import { preOrderError } from './authorPreOrderValidation.service.js'
import { listExpiredAuthorPreOrderHolds } from './authorPreOrderPaymentExpiry.service.js'
import { reconcileAuthorPreOrderOnce } from './authorPreOrderReconciliationRunner.service.js'

const CODE = /^PRE_ORDER_[A-Z0-9_]{3,80}$/

export async function reconcileExpiredAuthorPreOrderBatch({ limit = 10, signal } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10) {
    throw preOrderError('PRE_ORDER_RECONCILIATION_BATCH_INVALID', 'Batch size must be between 1 and 10', 400)
  }
  if (signal?.aborted) throw preOrderError('PRE_ORDER_RECONCILIATION_ABORTED', 'Reconciliation was interrupted', 503)
  const candidates = await listExpiredAuthorPreOrderHolds({ limit })
  const results = []
  for (const candidate of candidates) {
    if (signal?.aborted) throw preOrderError('PRE_ORDER_RECONCILIATION_ABORTED', 'Reconciliation was interrupted', 503)
    try {
      const result = await reconcileAuthorPreOrderOnce(candidate.order_id, { signal })
      results.push(result)
    } catch (error) {
      const raw = String(error?.code || '')
      results.push({
        order_id: candidate.order_id,
        action: 'manual_review',
        code: CODE.test(raw) ? raw : 'PRE_ORDER_RECONCILIATION_UNEXPECTED_FAILURE',
      })
    }
  }
  return {
    checked: results.length,
    paid_finalized: results.filter(row => row.action === 'payment_finalized').length,
    uninitialized_holds_released: results.filter(row => row.action === 'released_uninitialized_hold').length,
    needs_review: results.filter(row => ['manual_review', 'provider_not_confirmed', 'expiry_unresolved'].includes(row.action)).length,
    results,
    possible_more: candidates.length === limit,
  }
}
