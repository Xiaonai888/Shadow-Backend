import {
  requireReadEventId,
  validateFeaturedCardAudit,
  validateRewardReadiness,
} from './shadowReadEventRewardAudit.validation.js'

function count(data, key) {
  const value = Number(data?.[key])
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid Read Event preflight count: ${key}`)
  }
  return value
}

const INSPECTION_FLAGS = [
  'is_enabled', 'week_closed', 'activation_window_open',
  'featured_story_valid', 'card_tables_present', 'card_rls_enabled',
  'audit_functions_present', 'bridge_wrappers_present',
  'card_credit_functions_present', 'card_redeem_function_present',
]

export function validateReadEventPreflight(inspection, eventId) {
  const id = requireReadEventId(eventId)
  if (!inspection || inspection.ok !== true || inspection.event_id !== id ||
      typeof inspection.starts_on !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(inspection.starts_on) ||
      INSPECTION_FLAGS.some((key) => typeof inspection[key] !== 'boolean')) {
    throw new Error('Invalid Read Event integration preflight')
  }
  for (const key of ['mission_count', 'milestone_count', 'valid_daily_stories']) count(inspection, key)
  return inspection
}

export function validateReadEventCutover(cutover, eventId) {
  const id = requireReadEventId(eventId)
  if (!cutover || cutover.ok !== true || cutover.event_id !== id ||
      typeof cutover.safe_for_bridge_payout !== 'boolean' ||
      typeof cutover.requires_manual_reconciliation !== 'boolean' ||
      typeof cutover.clean_event !== 'boolean') {
    throw new Error('Invalid Read Event card cutover audit')
  }
  for (const key of [
    'granted_card_claims', 'uncredited_card_claims', 'granted_claim_cards',
    'featured_grant_rows', 'featured_granted_cards', 'wrong_story_claims',
  ]) count(cutover, key)
  return cutover
}

export function summarizeReadEventReleaseReadiness({ eventId, inspection, readiness, cards, cutover }) {
  const id = requireReadEventId(eventId)
  const plan = validateReadEventPreflight(inspection, id)
  const rewards = validateRewardReadiness(readiness, id)
  const ledger = validateFeaturedCardAudit(cards, id)
  const bridge = validateReadEventCutover(cutover, id)

  if (rewards.event_enabled !== plan.is_enabled ||
      rewards.week_closed !== plan.week_closed ||
      count(rewards, 'granted_card_claims') !== count(ledger, 'granted_card_claims') ||
      count(ledger, 'granted_card_claims') !== count(bridge, 'granted_card_claims')) {
    throw new Error('Inconsistent Read Event preflight sources')
  }

  const issues = []
  const fail = (condition, code) => { if (!condition) issues.push(code) }
  const planComplete = plan.mission_count === 35 && plan.milestone_count === 35 &&
    plan.valid_daily_stories === 7 && plan.featured_story_valid
  const installationComplete = plan.card_tables_present && plan.card_rls_enabled &&
    plan.audit_functions_present && plan.bridge_wrappers_present &&
    plan.card_credit_functions_present && plan.card_redeem_function_present

  fail(planComplete, 'EVENT_PLAN_INCOMPLETE')
  fail(plan.card_tables_present && plan.card_rls_enabled, 'CARD_STORAGE_NOT_READY')
  fail(plan.audit_functions_present, 'AUDIT_FUNCTIONS_MISSING')
  fail(plan.bridge_wrappers_present && plan.card_credit_functions_present, 'PAYOUT_BRIDGE_NOT_READY')
  fail(plan.card_redeem_function_present, 'CARD_REDEMPTION_RPC_MISSING')
  fail(bridge.safe_for_bridge_payout && !bridge.requires_manual_reconciliation,
    'CARD_CUTOVER_REQUIRES_REVIEW')
  fail(ledger.ledger_consistent && ledger.wrong_story_claims === 0 &&
    ledger.wrong_story_balances === 0 && ledger.wrong_story_redemptions === 0,
    'FEATURED_CARD_LEDGER_INCONSISTENT')
  fail(count(rewards, 'failed_claims') === 0, 'FAILED_REWARD_CLAIMS')
  fail(count(rewards, 'pending_claims') === 0, 'PENDING_REWARD_CLAIMS')

  const baseReady = issues.length === 0 && planComplete && installationComplete
  const payoutsComplete = rewards.daily_days_settled === 7 && rewards.overall_settled &&
    ledger.all_claims_credited && ledger.uncredited_claims === 0

  return {
    ok: true,
    event_id: id,
    starts_on: plan.starts_on,
    event_enabled: plan.is_enabled,
    week_closed: plan.week_closed,
    plan_complete: planComplete,
    installation_complete: installationComplete,
    bridge_safe: bridge.safe_for_bridge_payout,
    ready_to_enable: baseReady && plan.activation_window_open && !plan.is_enabled,
    ready_for_closed_week_review: baseReady && plan.week_closed && payoutsComplete,
    ready_for_featured_card_redemption: baseReady && plan.week_closed && payoutsComplete,
    issues: [...new Set(issues)],
    statistics: {
      participants: count(rewards, 'participants'),
      granted_claims: count(rewards, 'granted_claims'),
      pending_claims: count(rewards, 'pending_claims'),
      failed_claims: count(rewards, 'failed_claims'),
      daily_days_settled: count(rewards, 'daily_days_settled'),
      expected_card_claims: count(ledger, 'granted_card_claims'),
      credited_card_claims: count(ledger, 'grant_rows'),
      uncredited_card_claims: count(ledger, 'uncredited_claims'),
    },
  }
}
