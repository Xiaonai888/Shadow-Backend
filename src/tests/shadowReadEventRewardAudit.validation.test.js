import test from 'node:test'
import assert from 'node:assert/strict'
import {
  requireReadEventId,
  validateRewardReadiness,
  validateFeaturedCardAudit,
} from '../services/shadowReadEventRewardAudit.validation.js'

const id = 'c9dffb27-819c-4f7d-a8e4-cb5381c3151d'

const readiness = {
  ok: true, event_id: id, event_enabled: true, week_closed: true,
  overall_settled: true, daily_days_settled: 7, participants: 40,
  granted_claims: 60, pending_claims: 0, failed_claims: 0, granted_card_claims: 40,
}

const cards = {
  ok: true, event_id: id, featured_story_id: '123', granted_card_claims: 40,
  expected_claim_cards: 680, uncredited_claims: 0, wrong_story_claims: 0,
  grant_rows: 40, grant_cards: 680, invalid_grant_rows: 0,
  balance_granted_cards: 680, balance_spent_cards: 100,
  wrong_story_balances: 0, redemption_spent_cards: 100,
  wrong_story_redemptions: 0, reader_balance_mismatches: 0, ledger_consistent: true, all_claims_credited: true,
}

test('validates a reward summary', () => {
  assert.equal(validateRewardReadiness(readiness, id).daily_days_settled, 7)
})

test('validates a fully credited Featured Card ledger', () => {
  assert.equal(validateFeaturedCardAudit(cards, id).all_claims_credited, true)
})

test('rejects invalid IDs', () => {
  assert.throws(() => requireReadEventId('anything'), TypeError)
})

test('rejects too many settled days', () => {
  assert.throws(() => validateRewardReadiness({ ...readiness, daily_days_settled: 8 }, id))
})

test('rejects inconsistent ledger flags', () => {
  assert.throws(() => validateFeaturedCardAudit({ ...cards, ledger_consistent: false }, id))
})

test('rejects balance overflow', () => {
  assert.throws(() => validateFeaturedCardAudit({ ...cards, balance_spent_cards: 690 }, id))
})
