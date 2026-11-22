import { preOrderError } from './authorPreOrderValidation.service.js'
import {
  AUTHOR_PREORDER_RECON_OPS_COOLDOWN_MS,
  authorPreOrderReconciliationManualEnabled,
  authorPreOrderReconciliationSafeErrorCode,
  requireAuthorPreOrderReconciliationManualEnabled,
  validateAuthorPreOrderReconciliationOpsLimit,
} from './authorPreOrderReconciliationOpsPolicy.service.js'
import { runAuthorPreOrderReconciliationOpsCycle } from './authorPreOrderReconciliationOpsCycle.service.js'

let pending = null
let lastStartedAt = null
let lastFinishedAt = null
let lastErrorCode = null
let lastSummary = null

export function getAuthorPreOrderReconciliationOpsManualState() {
  const nextAllowed = lastStartedAt === null ? null : lastStartedAt + AUTHOR_PREORDER_RECON_OPS_COOLDOWN_MS
  return {
    enabled: authorPreOrderReconciliationManualEnabled(),
    running: pending !== null,
    last_started_at: lastStartedAt === null ? null : new Date(lastStartedAt).toISOString(),
    last_finished_at: lastFinishedAt,
    next_allowed_at: nextAllowed === null ? null : new Date(nextAllowed).toISOString(),
    last_error_code: lastErrorCode,
    last_summary: lastSummary,
    scheduled: false,
    automatic_runs: false,
  }
}

export async function runAuthorPreOrderManualReconciliation({ limit = 4, signal } = {}) {
  requireAuthorPreOrderReconciliationManualEnabled()
  const safeLimit = validateAuthorPreOrderReconciliationOpsLimit(limit)
  if (signal?.aborted) {
    throw preOrderError('PRE_ORDER_RECON_OPS_ABORTED', 'Manual reconciliation was interrupted', 503)
  }
  if (pending) {
    throw preOrderError('PRE_ORDER_RECON_OPS_ALREADY_RUNNING', 'Manual reconciliation is already running', 409)
  }
  const now = Date.now()
  if (lastStartedAt !== null && now - lastStartedAt < AUTHOR_PREORDER_RECON_OPS_COOLDOWN_MS) {
    throw preOrderError('PRE_ORDER_RECON_OPS_COOLDOWN', 'Manual reconciliation cooldown has not elapsed', 429)
  }
  lastStartedAt = now
  const work = (async () => {
    try {
      const result = await runAuthorPreOrderReconciliationOpsCycle({ limit: safeLimit, signal })
      lastSummary = {
        ok: result.ok,
        partial: result.partial,
        checked: result.checked,
        paid_finalized: result.paid_finalized,
        uninitialized_holds_released: result.uninitialized_holds_released,
        needs_review: result.needs_review,
        possible_more: result.possible_more,
        error_codes: result.errors.map(item => item.code),
      }
      lastErrorCode = result.ok ? null : 'PRE_ORDER_RECON_OPS_PARTIAL_FAILURE'
      return result
    } catch (error) {
      lastErrorCode = authorPreOrderReconciliationSafeErrorCode(error)
      throw error
    } finally {
      lastFinishedAt = new Date().toISOString()
    }
  })()
  pending = work
  try { return await work } finally { if (pending === work) pending = null }
}
