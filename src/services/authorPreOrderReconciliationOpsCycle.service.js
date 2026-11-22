import { preOrderError } from './authorPreOrderValidation.service.js'
import { reconcileExpiredAuthorPreOrderBatch } from './authorPreOrderReconciliationBatch.service.js'
import { reconcileExpiredAuthorPreOrderMultiVolumeBatch } from './authorPreOrderMultiVolumeReconciliationBatch.service.js'
import {
  allocateAuthorPreOrderReconciliationOpsBatch,
  authorPreOrderReconciliationSafeErrorCode,
} from './authorPreOrderReconciliationOpsPolicy.service.js'

function safeCount(value, max, name) {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 0 || number > max) {
    throw preOrderError('PRE_ORDER_RECON_OPS_RESULT_INVALID', `Invalid reconciliation ${name}`, 503)
  }
  return number
}

function checkedResult(result, scope, limit) {
  if (!result || !Array.isArray(result.results) || result.results.length > limit) {
    throw preOrderError('PRE_ORDER_RECON_OPS_RESULT_INVALID', `Invalid ${scope} reconciliation results`, 503)
  }
  const checked = safeCount(result.checked, limit, 'checked count')
  if (result.results.length !== checked) {
    throw preOrderError('PRE_ORDER_RECON_OPS_RESULT_INVALID', `Invalid ${scope} reconciliation count`, 503)
  }
  const paid = safeCount(result.paid_finalized, checked, 'finalized payments')
  const released = safeCount(result.uninitialized_holds_released, checked, 'released holds')
  const review = safeCount(result.needs_review, checked, 'review count')
  if (paid + released + review > checked || typeof result.possible_more !== 'boolean') {
    throw preOrderError('PRE_ORDER_RECON_OPS_RESULT_INVALID', `Inconsistent ${scope} reconciliation totals`, 503)
  }
  return {
    scope,
    checked,
    paid_finalized: paid,
    uninitialized_holds_released: released,
    needs_review: review,
    possible_more: result.possible_more,
    results: result.results,
  }
}

async function attemptScope(scope, limit, execute, signal) {
  try {
    const result = await execute({ limit, signal })
    return { ok: true, ...checkedResult(result, scope, limit) }
  } catch (error) {
    console.error('PRE_ORDER_RECON_OPS_SCOPE_FAILED:', scope, authorPreOrderReconciliationSafeErrorCode(error))
    return { ok: false, scope, code: authorPreOrderReconciliationSafeErrorCode(error),
      checked: 0, paid_finalized: 0, uninitialized_holds_released: 0,
      needs_review: 0, possible_more: true, results: [] }
  }
}

export async function runAuthorPreOrderReconciliationOpsCycle({ limit = 4, signal } = {}) {
  const allocation = allocateAuthorPreOrderReconciliationOpsBatch(limit)
  if (signal?.aborted) {
    throw preOrderError('PRE_ORDER_RECON_OPS_ABORTED', 'Manual reconciliation was interrupted', 503)
  }
  const legacy = await attemptScope('legacy', allocation.legacy_limit,
    reconcileExpiredAuthorPreOrderBatch, signal)
  if (signal?.aborted) {
    throw preOrderError('PRE_ORDER_RECON_OPS_ABORTED', 'Manual reconciliation was interrupted', 503)
  }
  const multi = await attemptScope('multi_volume', allocation.volume_limit,
    reconcileExpiredAuthorPreOrderMultiVolumeBatch, signal)
  return {
    ok: legacy.ok && multi.ok,
    partial: !legacy.ok || !multi.ok,
    max_orders: allocation.max_orders,
    checked: legacy.checked + multi.checked,
    paid_finalized: legacy.paid_finalized + multi.paid_finalized,
    uninitialized_holds_released: legacy.uninitialized_holds_released + multi.uninitialized_holds_released,
    needs_review: legacy.needs_review + multi.needs_review,
    possible_more: legacy.possible_more || multi.possible_more,
    errors: [legacy, multi].filter(item => !item.ok).map(item => ({ scope: item.scope, code: item.code })),
    scopes: [legacy, multi],
    executed_once: true,
    auto_scheduler_started: false,
  }
}
