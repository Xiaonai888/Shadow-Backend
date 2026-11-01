const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function requireReadEventId(value) {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new TypeError('Invalid Read Event ID')
  }
  return value
}

function nonnegativeInteger(object, key) {
  const value = Number(object?.[key])
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid Read Event audit ${key}`)
  }
  return value
}

export function validateRewardReadiness(data, eventId) {
  if (!data || data.ok !== true || data.event_id !== requireReadEventId(eventId) ||
    typeof data.event_enabled !== 'boolean' ||
    typeof data.week_closed !== 'boolean' ||
    typeof data.overall_settled !== 'boolean') {
    throw new Error('Invalid Read Event reward readiness response')
  }
  for (const key of [
    'daily_days_settled', 'participants', 'granted_claims', 'pending_claims',
    'failed_claims', 'granted_card_claims',
  ]) nonnegativeInteger(data, key)
  if (Number(data.daily_days_settled) > 7 ||
    Number(data.granted_card_claims) > Number(data.granted_claims)) {
    throw new Error('Inconsistent Read Event readiness counts')
  }
  return data
}

export function validateFeaturedCardAudit(data, eventId) {
  if (!data || data.ok !== true || data.event_id !== requireReadEventId(eventId) ||
    typeof data.featured_story_id !== 'string' || !data.featured_story_id.trim() ||
    typeof data.ledger_consistent !== 'boolean' ||
    typeof data.all_claims_credited !== 'boolean') {
    throw new Error('Invalid Featured Card audit response')
  }
  const keys = [
    'granted_card_claims', 'expected_claim_cards', 'uncredited_claims',
    'wrong_story_claims', 'grant_rows', 'grant_cards', 'invalid_grant_rows',
    'balance_granted_cards', 'balance_spent_cards', 'wrong_story_balances',
    'redemption_spent_cards', 'wrong_story_redemptions', 'reader_balance_mismatches',
  ]
  for (const key of keys) nonnegativeInteger(data, key)
  if (data.all_claims_credited && !data.ledger_consistent) {
    throw new Error('Featured Card audit flags disagree')
  }
  if (Number(data.balance_spent_cards) > Number(data.balance_granted_cards)) {
    throw new Error('Featured Card audit balance overflow')
  }
  return data
}
