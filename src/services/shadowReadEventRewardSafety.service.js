function issue(code, severity, details = {}) {
  return { code, severity, ...details }
}

function count(value, field) {
  if (!Number.isSafeInteger(Number(value)) || Number(value) < 0) {
    throw new TypeError(`Invalid reward audit counter: ${field}`)
  }
  return Number(value)
}

export function assessShadowReadEventRewardSafety(audit) {
  const readiness = audit?.readiness
  const cards = audit?.featured_cards
  const eventId = audit?.event_id
  if (typeof eventId !== 'string' || !readiness || !cards ||
      readiness.event_id !== eventId || cards.event_id !== eventId ||
      readiness.ok !== true || cards.ok !== true) {
    throw new TypeError('Invalid Shadow Read Event audit')
  }

  const settledDays = count(readiness.daily_days_settled, 'daily_days_settled')
  const failedClaims = count(readiness.failed_claims, 'failed_claims')
  const pendingClaims = count(readiness.pending_claims, 'pending_claims')
  const readCardClaims = count(readiness.granted_card_claims, 'granted_card_claims')
  const cardClaims = count(cards.granted_card_claims, 'featured_cards.granted_card_claims')
  const uncredited = count(cards.uncredited_claims, 'uncredited_claims')
  const wrongStory = count(cards.wrong_story_claims, 'wrong_story_claims')
  const invalidGrants = count(cards.invalid_grant_rows, 'invalid_grant_rows')
  const readerMismatches = count(cards.reader_balance_mismatches, 'reader_balance_mismatches')
  const missingBalance = count(cards.expected_claim_cards, 'expected_claim_cards') -
    count(cards.grant_cards, 'grant_cards')

  if (![readiness.event_enabled, readiness.week_closed, readiness.overall_settled,
    cards.ledger_consistent, cards.all_claims_credited].every(v => typeof v === 'boolean') ||
    settledDays > 7) {
    throw new TypeError('Invalid Shadow Read Event audit flags')
  }

  const blockers = []
  const notices = []
  if (!cards.ledger_consistent || invalidGrants || readerMismatches || wrongStory) {
    blockers.push(issue('FEATURED_CARD_LEDGER_INCONSISTENT', 'blocker', {
      invalid_grants: invalidGrants, mismatched_readers: readerMismatches,
      wrong_story_claims: wrongStory,
    }))
  }
  if (uncredited || missingBalance !== 0 || readCardClaims !== cardClaims ||
    (readCardClaims > 0 && !cards.all_claims_credited)) {
    blockers.push(issue('FEATURED_CARD_CLAIMS_UNRECONCILED', 'blocker', {
      uncredited_claims: uncredited, difference_in_card_amount: missingBalance,
      claim_count_difference: readCardClaims - cardClaims,
    }))
  }
  if (failedClaims > 0) {
    blockers.push(issue('FAILED_REWARD_CLAIMS', 'blocker', { count: failedClaims }))
  }
  if (!readiness.week_closed) {
    notices.push(issue('EVENT_WEEK_NOT_FINISHED', 'info'))
  } else if (settledDays < 7 || !readiness.overall_settled) {
    notices.push(issue('EVENT_SETTLEMENT_INCOMPLETE', 'info', {
      settled_days: settledDays, overall_settled: readiness.overall_settled,
    }))
  }
  if (pendingClaims > 0) {
    notices.push(issue('PENDING_REWARD_CLAIMS', 'info', { count: pendingClaims }))
  }

  return {
    ok: true,
    event_id: eventId,
    read_only: true,
    accounting_safe: blockers.length === 0,
    payout_settled: Boolean(readiness.week_closed && settledDays === 7 &&
      readiness.overall_settled && pendingClaims === 0 && failedClaims === 0),
    blockers,
    notices,
    reward_claims: {
      pending: pendingClaims,
      failed: failedClaims,
      granted_card_claims: readCardClaims,
      uncredited_card_claims: uncredited,
    },
    integration_verified: false,
    production_ready: false,
  }
}

export async function readShadowReadEventRewardSafety({ eventId }) {
  const { readShadowReadEventRewardAudit } = await import('./shadowReadEventRewardAudit.service.js')
  const audit = await readShadowReadEventRewardAudit({ eventId })
  return assessShadowReadEventRewardSafety(audit)
}
