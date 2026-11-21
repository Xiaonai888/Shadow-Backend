import { preOrderError } from './authorPreOrderValidation.service.js'
import { preOrderPaymentTransaction } from './authorPreOrderPaymentValidation.service.js'

const TERMINAL_PROOFS = new Set(['EXPIRED', 'CANCELLED'])
const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{7,119}$/
const MIN_REVIEW_AGE_MS = 2 * 60 * 1000
const RELEASE_GRACE_MS = 30 * 60 * 1000

function timestamp(value, field) {
  const time = Date.parse(String(value || ''))
  if (!Number.isFinite(time)) {
    throw preOrderError('PRE_ORDER_TERMINAL_TIME_INVALID', `Invalid ${field}`, 503)
  }
  return time
}

export function assessExpiredPreOrderPayment(intent, hold, settlement, { now = Date.now() } = {}) {
  preOrderPaymentTransaction(intent?.merchant_transaction_id)
  const intentExpiry = timestamp(intent?.expires_at, 'payment intent expiry')
  const holdExpiry = timestamp(hold?.expires_at, 'stock hold expiry')
  if (settlement?.confirmed === true) {
    return { action: 'finalize_paid', payment_verified: true, release_allowed: false }
  }
  if (settlement?.confirmed !== false || hold?.status !== 'held') {
    return { action: 'manual_review', payment_verified: false, release_allowed: false }
  }
  if (!Number.isFinite(now) || now < Math.max(intentExpiry, holdExpiry) + RELEASE_GRACE_MS) {
    return { action: 'grace_period', payment_verified: false, release_allowed: false }
  }
  return {
    action: 'provider_terminal_evidence_required',
    payment_verified: false,
    release_allowed: false,
  }
}

export function validateManualTerminalAttestation(attestation, { now = Date.now() } = {}) {
  if (!attestation || typeof attestation !== 'object' || Array.isArray(attestation) ||
      attestation.confirmed_terminal !== true || attestation.reverified_against_provider !== true ||
      !TERMINAL_PROOFS.has(attestation.provider_terminal_status)) {
    throw preOrderError('PRE_ORDER_TERMINAL_PROOF_REQUIRED', 'A documented terminal provider decision is required', 409)
  }
  const evidence = String(attestation.evidence_reference || '').trim()
  if (!REFERENCE.test(evidence)) {
    throw preOrderError('PRE_ORDER_TERMINAL_EVIDENCE_INVALID', 'A non-sensitive provider evidence reference is required', 400)
  }
  const verifiedAt = timestamp(attestation.verified_at, 'provider verification time')
  if (!Number.isFinite(now) || verifiedAt < now - 5 * 60 * 1000 || verifiedAt > now + 30 * 1000) {
    throw preOrderError('PRE_ORDER_TERMINAL_EVIDENCE_STALE', 'Provider verification must be recent', 409)
  }
  return {
    provider_terminal_status: attestation.provider_terminal_status,
    evidence_reference: evidence,
    verified_at: new Date(verifiedAt).toISOString(),
    min_review_age_ms: MIN_REVIEW_AGE_MS,
    release_grace_ms: RELEASE_GRACE_MS,
  }
}
