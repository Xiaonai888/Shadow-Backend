import test from 'node:test'
import assert from 'node:assert/strict'
import {
  assessAuthorPreOrderMultiVolumeTerminalEligibility,
  authorPreOrderMultiVolumeTerminalManualEnabled,
  requireAuthorPreOrderMultiVolumeTerminalManualEnabled,
} from '../src/services/authorPreOrderMultiVolumeTerminalPolicy.service.js'

const NOW = Date.parse('2026-11-22T12:00:00.000Z')
const iso = minutesAgo => new Date(NOW - minutesAgo * 60_000).toISOString()

function fixture() {
  return {
    inspection: {
      hold_type: 'multi_volume', issues: [], requires_manual_review: false,
      payment_status: 'pending', hold_status: 'held', has_fee_ledger: false,
      has_payment_intent: true, hold_expired: true, hold_expires_at: iso(40),
    },
    intent: {
      currency: 'USD', merchant_transaction_id: 'P123456789012',
      expires_at: iso(40), finalized_at: null,
    },
    review: {
      merchant_transaction_id: 'P123456789012', review_count: 2,
      first_checked_at: iso(8), last_checked_at: iso(1), released_at: null,
    },
  }
}

function check(change = {}) {
  const source = fixture()
  return assessAuthorPreOrderMultiVolumeTerminalEligibility(
    { ...source.inspection, ...(change.inspection || {}) },
    { ...source.intent, ...(change.intent || {}) },
    { ...source.review, ...(change.review || {}) },
    { now: NOW },
  )
}

test('eligibility never directly authorizes stock release', () => {
  const result = check()
  assert.equal(result.ready_for_terminal_proof, true)
  assert.equal(result.release_allowed, false)
  assert.equal(result.verified_provider_terminal_evidence_required, true)
})

test('paid, consumed, or unverified order cannot be released', () => {
  for (const patch of [
    { payment_status: 'paid' }, { hold_status: 'consumed' },
    { has_fee_ledger: true }, { has_payment_intent: false },
    { requires_manual_review: true },
  ]) {
    const result = check({ inspection: patch })
    assert.equal(result.ready_for_terminal_proof, false)
    assert.equal(result.release_allowed, false)
  }
})

test('release grace period uses the later of hold and intent expiries', () => {
  const result = check({ intent: { expires_at: iso(20) } })
  assert.equal(result.code, 'PRE_ORDER_MULTI_TERMINAL_GRACE_REQUIRED')
  assert.equal(result.release_allowed, false)
})

test('two well-spaced recent reviews matching the same transaction are mandatory', () => {
  for (const patch of [
    { review_count: 1 },
    { first_checked_at: iso(1) },
    { last_checked_at: iso(6) },
    { merchant_transaction_id: 'P999999999999' },
    { released_at: iso(1) },
  ]) {
    const result = check({ review: patch })
    assert.equal(result.ready_for_terminal_proof, false)
    assert.equal(result.release_allowed, false)
  }
})

test('terminal release switch defaults to disabled and only literal true enables', () => {
  const original = process.env.AUTHOR_PREORDER_MULTI_TERMINAL_MANUAL_ENABLED
  try {
    delete process.env.AUTHOR_PREORDER_MULTI_TERMINAL_MANUAL_ENABLED
    assert.equal(authorPreOrderMultiVolumeTerminalManualEnabled(), false)
    assert.throws(() => requireAuthorPreOrderMultiVolumeTerminalManualEnabled(), {
      code: 'PRE_ORDER_MULTI_TERMINAL_DISABLED',
    })
    process.env.AUTHOR_PREORDER_MULTI_TERMINAL_MANUAL_ENABLED = 'true'
    assert.equal(authorPreOrderMultiVolumeTerminalManualEnabled(), true)
    assert.doesNotThrow(() => requireAuthorPreOrderMultiVolumeTerminalManualEnabled())
  } finally {
    if (original === undefined) delete process.env.AUTHOR_PREORDER_MULTI_TERMINAL_MANUAL_ENABLED
    else process.env.AUTHOR_PREORDER_MULTI_TERMINAL_MANUAL_ENABLED = original
  }
})
