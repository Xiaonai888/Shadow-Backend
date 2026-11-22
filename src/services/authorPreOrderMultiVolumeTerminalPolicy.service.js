import { preOrderError } from './authorPreOrderValidation.service.js'

const WAIT_MS = 30 * 60 * 1000
const MIN_REVIEW_MS = 2 * 60 * 1000
const MAX_REVIEW_AGE_MS = 5 * 60 * 1000

function validTime(value) {
  if (typeof value !== 'string' || !value.trim()) return null
  const result = Date.parse(value)
  return Number.isFinite(result) ? result : null
}

function blocked(code) {
  return { ready_for_terminal_proof: false, release_allowed: false, code }
}

export function authorPreOrderMultiVolumeTerminalManualEnabled() {
  return String(process.env.AUTHOR_PREORDER_MULTI_TERMINAL_MANUAL_ENABLED || '').trim().toLowerCase() === 'true'
}

export function requireAuthorPreOrderMultiVolumeTerminalManualEnabled() {
  if (!authorPreOrderMultiVolumeTerminalManualEnabled()) {
    throw preOrderError('PRE_ORDER_MULTI_TERMINAL_DISABLED', 'Manual terminal review is disabled', 503)
  }
}

export function assessAuthorPreOrderMultiVolumeTerminalEligibility(inspection, intent, review, { now = Date.now() } = {}) {
  if (!Number.isFinite(now)) {
    throw preOrderError('PRE_ORDER_MULTI_TERMINAL_TIME_INVALID', 'Invalid terminal inspection time', 400)
  }
  if (!inspection || inspection.hold_type !== 'multi_volume') {
    return blocked('PRE_ORDER_MULTI_TERMINAL_HOLD_TYPE_INVALID')
  }
  if (inspection.requires_manual_review || !Array.isArray(inspection.issues) || inspection.issues.length) {
    return blocked('PRE_ORDER_MULTI_TERMINAL_INVENTORY_REVIEW_REQUIRED')
  }
  if (inspection.payment_status !== 'pending' || inspection.hold_status !== 'held' ||
      inspection.has_fee_ledger || !inspection.has_payment_intent) {
    return blocked('PRE_ORDER_MULTI_TERMINAL_ORDER_NOT_PENDING')
  }
  if (!intent || intent.finalized_at || intent.currency !== 'USD' || !intent.merchant_transaction_id) {
    return blocked('PRE_ORDER_MULTI_TERMINAL_INTENT_INVALID')
  }
  const holdExpiry = validTime(inspection.hold_expires_at)
  const intentExpiry = validTime(intent.expires_at)
  if (holdExpiry === null || intentExpiry === null) {
    return blocked('PRE_ORDER_MULTI_TERMINAL_EXPIRY_INVALID')
  }
  const releaseAfter = Math.max(holdExpiry, intentExpiry) + WAIT_MS
  if (now < releaseAfter || !inspection.hold_expired) {
    return { ...blocked('PRE_ORDER_MULTI_TERMINAL_GRACE_REQUIRED'), eligible_after: new Date(releaseAfter).toISOString() }
  }
  if (!review || review.released_at || review.merchant_transaction_id !== intent.merchant_transaction_id) {
    return blocked('PRE_ORDER_MULTI_TERMINAL_REVIEWS_REQUIRED')
  }
  const firstChecked = validTime(review.first_checked_at)
  const lastChecked = validTime(review.last_checked_at)
  if (!Number.isSafeInteger(Number(review.review_count)) || Number(review.review_count) < 2 ||
      firstChecked === null || lastChecked === null ||
      firstChecked > now - MIN_REVIEW_MS || lastChecked < now - MAX_REVIEW_AGE_MS ||
      lastChecked > now + 30_000 || firstChecked > lastChecked) {
    return blocked('PRE_ORDER_MULTI_TERMINAL_REVIEWS_NOT_READY')
  }
  return {
    ready_for_terminal_proof: true,
    release_allowed: false,
    code: 'PRE_ORDER_MULTI_TERMINAL_PROOF_REQUIRED',
    eligible_after: new Date(releaseAfter).toISOString(),
    verified_provider_terminal_evidence_required: true,
  }
}
