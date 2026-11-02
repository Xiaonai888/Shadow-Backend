import test from 'node:test'
import assert from 'node:assert/strict'
import { assessShadowReadEventRewardSafety } from '../services/shadowReadEventRewardSafety.service.js'

const id = 'c9dffb27-819c-4f7d-a8e4-cb5381c3151d'
const baseline = {
  event_id: id,
  readiness: {
    ok: true, event_id: id, event_enabled: true, week_closed: true,
    daily_days_settled: 7, overall_settled: true,
    granted_claims: 30, pending_claims: 0, failed_claims: 0,
    granted_card_claims: 10,
  },
  featured_cards: {
    ok: true, event_id: id, ledger_consistent: true, all_claims_credited: true,
    granted_card_claims: 10, uncredited_claims: 0, expected_claim_cards: 100,
    grant_cards: 100, wrong_story_claims: 0, invalid_grant_rows: 0,
    reader_balance_mismatches: 0,
  },
}

function modify(readiness = {}, cards = {}) {
  return {
    ...baseline,
    readiness: { ...baseline.readiness, ...readiness },
    featured_cards: { ...baseline.featured_cards, ...cards },
  }
}

test('reconciled event is accounting-safe but not production-approved', () => {
  const safety = assessShadowReadEventRewardSafety(baseline)
  assert.equal(safety.accounting_safe, true)
  assert.equal(safety.payout_settled, true)
  assert.equal(safety.production_ready, false)
  assert.equal(safety.integration_verified, false)
  assert.deepEqual(safety.blockers, [])
})

test('missing credits stop approval', () => {
  const safety = assessShadowReadEventRewardSafety(modify({}, {
    uncredited_claims: 1, all_claims_credited: false, grant_cards: 90,
  }))
  assert.equal(safety.accounting_safe, false)
  assert.ok(safety.blockers.some(x => x.code === 'FEATURED_CARD_CLAIMS_UNRECONCILED'))
})

test('a per-reader balance mismatch blocks payouts', () => {
  const safety = assessShadowReadEventRewardSafety(modify({}, {
    reader_balance_mismatches: 1, ledger_consistent: false,
  }))
  assert.equal(safety.accounting_safe, false)
})

test('failed claims stop approval even with a consistent card ledger', () => {
  const safety = assessShadowReadEventRewardSafety(modify({ failed_claims: 2 }))
  assert.ok(safety.blockers.some(x => x.code === 'FAILED_REWARD_CLAIMS'))
})

test('incomplete settlement is informational, never deemed completed', () => {
  const safety = assessShadowReadEventRewardSafety(modify({
    daily_days_settled: 5, overall_settled: false, pending_claims: 3,
  }))
  assert.equal(safety.payout_settled, false)
  assert.ok(safety.notices.some(x => x.code === 'EVENT_SETTLEMENT_INCOMPLETE'))
})

test('an active week is not counted as a finalized payout', () => {
  const safety = assessShadowReadEventRewardSafety(modify({ week_closed: false }))
  assert.equal(safety.payout_settled, false)
  assert.ok(safety.notices.some(x => x.code === 'EVENT_WEEK_NOT_FINISHED'))
})

test('rejects mismatched event IDs', () => {
  assert.throws(() => assessShadowReadEventRewardSafety({
    ...baseline, featured_cards: { ...baseline.featured_cards, event_id: 'wrong' },
  }), TypeError)
})
