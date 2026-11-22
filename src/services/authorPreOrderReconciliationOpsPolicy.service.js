import { preOrderError } from './authorPreOrderValidation.service.js'

export const AUTHOR_PREORDER_RECON_OPS_MAX_BATCH = 10
export const AUTHOR_PREORDER_RECON_OPS_COOLDOWN_MS = 10 * 60 * 1000
export const AUTHOR_PREORDER_RECON_OPS_HEALTH_CACHE_MS = 60 * 1000

export function authorPreOrderReconciliationManualEnabled() {
  return String(process.env.AUTHOR_PREORDER_RECONCILIATION_MANUAL_ENABLED || '')
    .trim().toLowerCase() === 'true'
}

export function validateAuthorPreOrderReconciliationOpsLimit(limit = 4) {
  if (!Number.isSafeInteger(limit) || limit < 2 || limit > AUTHOR_PREORDER_RECON_OPS_MAX_BATCH) {
    throw preOrderError('PRE_ORDER_RECON_OPS_LIMIT_INVALID', 'Manual reconciliation batch size must be between 2 and 10', 400)
  }
  return limit
}

export function allocateAuthorPreOrderReconciliationOpsBatch(limit = 4) {
  const allowed = validateAuthorPreOrderReconciliationOpsLimit(limit)
  const legacy = Math.floor(allowed / 2)
  return { legacy_limit: legacy, volume_limit: allowed - legacy, max_orders: allowed }
}

export function requireAuthorPreOrderReconciliationManualEnabled() {
  if (!authorPreOrderReconciliationManualEnabled()) {
    throw preOrderError('PRE_ORDER_RECON_OPS_DISABLED', 'Manual payment reconciliation is disabled', 503)
  }
}

export function authorPreOrderReconciliationSafeErrorCode(error) {
  const code = String(error?.code || '')
  return /^PRE_ORDER_[A-Z0-9_]{3,80}$/.test(code)
    ? code : 'PRE_ORDER_RECON_OPS_UNEXPECTED'
}
