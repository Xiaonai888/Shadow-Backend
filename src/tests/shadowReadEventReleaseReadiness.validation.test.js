import test from 'node:test'
import assert from 'node:assert/strict'
import {
  summarizeReadEventReleaseReadiness,
  validateReadEventPreflight,
  validateReadEventCutover,
} from '../services/shadowReadEventReleaseReadiness.validation.js'

const eventId = 'c9dffb27-819c-4f7d-a8e4-cb5381c3151d'
const inspection = {
  ok: true, event_id: eventId, starts_on: '2026-11-02', is_enabled: false,
  week_closed: false, activation_window_open: true,
  mission_count: 35, milestone_count: 35, valid_daily_stories: 7,
  featured_story_valid: true, card_tables_present: true, card_rls_enabled: true,
  audit_functions_present: true, bridge_wrappers_present: true,
  card_credit_functions_present: true, card_redeem_function_present: true,
}
const readiness = {
  ok: true, event_id: eventId, event_enabled: false, week_closed: false,
  overall_settled: false, daily_days_settled: 0, participants: 0,
  granted_claims: 0, pending_claims: 0, failed_claims: 0, granted_card_claims: 0,
}
const cards = {
  ok: true, event_id: eventId, featured_story_id: 'story-123',
  granted_card_claims: 0, expected_claim_cards: 0, uncredited_claims: 0,
  wrong_story_claims: 0, grant_rows: 0, grant_cards: 0, invalid_grant_rows: 0,
  balance_granted_cards: 0, balance_spent_cards: 0, wrong_story_balances: 0,
  redemption_spent_cards: 0, wrong_story_redemptions: 0,
  reader_balance_mismatches: 0, ledger_consistent: true, all_claims_credited: true,
}
const cutover = {
  ok: true, event_id: eventId, granted_card_claims: 0, uncredited_card_claims: 0,
  granted_claim_cards: 0, featured_grant_rows: 0, featured_granted_cards: 0,
  wrong_story_claims: 0, clean_event: true,
  requires_manual_reconciliation: false, safe_for_bridge_payout: true,
}
function review(overrides = {}) {
  return summarizeReadEventReleaseReadiness({
    eventId, inspection, readiness, cards, cutover, ...overrides,
  })
}

test('a clean new event can pass pre-activation checks without claiming to be paid', () => {
  const data = review()
  assert.equal(data.ready_to_enable, true)
  assert.equal(data.ready_for_featured_card_redemption, false)
  assert.deepEqual(data.issues, [])
})

test('missing bridge wrappers fail closed', () => {
  const result = review({ inspection: { ...inspection, bridge_wrappers_present: false } })
  assert.equal(result.ready_to_enable, false)
  assert.ok(result.issues.includes('PAYOUT_BRIDGE_NOT_READY'))
})

test('uncredited legacy claims block release', () => {
  const result = review({ cutover: {
    ...cutover, granted_card_claims: 1, uncredited_card_claims: 1,
    requires_manual_reconciliation: true, safe_for_bridge_payout: false,
  }, cards: { ...cards, granted_card_claims: 1, uncredited_claims: 1 },
  readiness: { ...readiness, granted_card_claims: 1, granted_claims: 1 } })
  assert.equal(result.ready_to_enable, false)
  assert.ok(result.issues.includes('CARD_CUTOVER_REQUIRES_REVIEW'))
})

test('mismatched audits are rejected', () => {
  assert.throws(() => review({
    readiness: { ...readiness, granted_card_claims: 1, granted_claims: 1 },
  }), /Inconsistent Read Event preflight sources/)
})

test('incomplete missions block activation', () => {
  const result = review({ inspection: { ...inspection, mission_count: 34 } })
  assert.equal(result.ready_to_enable, false)
  assert.ok(result.issues.includes('EVENT_PLAN_INCOMPLETE'))
})

test('finished events are not eligible for new activation', () => {
  const result = review({ inspection: { ...inspection, activation_window_open: false } })
  assert.equal(result.ready_to_enable, false)
})

test('completed event with fully credited cards may pass review', () => {
  const result = review({
    inspection: { ...inspection, week_closed: true, activation_window_open: false, is_enabled: true },
    readiness: { ...readiness, week_closed: true, event_enabled: true, daily_days_settled: 7, overall_settled: true },
  })
  assert.equal(result.ready_for_closed_week_review, true)
  assert.equal(result.ready_for_featured_card_redemption, true)
})

test('invalid boolean response is rejected', () => {
  assert.throws(() => validateReadEventPreflight({ ...inspection, card_rls_enabled: 'true' }, eventId))
})

test('invalid cutover response is rejected', () => {
  assert.throws(() => validateReadEventCutover({ ...cutover, uncredited_card_claims: -1 }, eventId))
})
