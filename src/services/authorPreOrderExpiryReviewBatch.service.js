import { preOrderError } from './authorPreOrderValidation.service.js'
import { listExpiredAuthorPreOrderHolds } from './authorPreOrderPaymentExpiry.service.js'
import { reviewExpiredPreOrderPayment } from './authorPreOrderTerminalReview.service.js'

export async function inspectExpiredPreOrderPayments({ limit = 10, signal } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) {
    throw preOrderError('PRE_ORDER_TERMINAL_BATCH_INVALID', 'Batch size must be between 1 and 20', 400)
  }
  const candidates = await listExpiredAuthorPreOrderHolds({ limit })
  const results = []
  for (const row of candidates) {
    if (signal?.aborted) throw preOrderError('PRE_ORDER_TERMINAL_BATCH_ABORTED', 'Review batch was interrupted', 503)
    try {
      const result = await reviewExpiredPreOrderPayment(row.order_id, { signal })
      results.push(result)
    } catch (error) {
      const code = String(error?.code || '')
      results.push({
        order_id: row.order_id,
        action: 'manual_review_required',
        release_allowed: false,
        code: /^PRE_ORDER_[A-Z0-9_]+$/.test(code) ? code : 'PRE_ORDER_TERMINAL_REVIEW_ERROR',
      })
    }
  }
  return {
    reviewed: results.length,
    released_automatically: 0,
    remaining_possible: candidates.length === limit,
    results,
  }
}
