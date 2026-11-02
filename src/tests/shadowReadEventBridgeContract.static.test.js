import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const sql = (name) => readFileSync(new URL(`../sql/${name}`, import.meta.url), 'utf8')
const server = () => readFileSync(new URL('../../server.js', import.meta.url), 'utf8')

const required = [
  'shadow_read_event_card_cutover_preflight_v1.sql',
  'shadow_read_event_card_bridge_helpers_v1.sql',
  'shadow_read_event_overall_featured_card_bridge_v2.sql',
  'shadow_read_event_participation_featured_card_bridge_v2.sql',
]

test('all staged reward bridge migrations are present', () => {
  for (const name of required) assert.match(sql(name), /BEGIN;[\s\S]*COMMIT;/)
})

test('legacy card conversion credits and reverses in one transaction', () => {
  const text = sql('shadow_read_event_card_bridge_helpers_v1.sql')
  assert.match(text, /shadow_read_event_credit_featured_cards\(p_claim_id\)/)
  assert.match(text, /UPDATE public\.user_wallets AS w/)
  assert.match(text, /story_card_balance\s*=\s*COALESCE\(w\.story_card_balance, 0\)\s*-\s*v_claim\.card_amount/)
  assert.match(text, /RAISE EXCEPTION 'Legacy card balance could not be reversed/)
})

test('overall settlement bridge checks past uncredited claims and verifies cards moved', () => {
  const text = sql('shadow_read_event_overall_featured_card_bridge_v2.sql')
  assert.match(text, /Historical uncredited Read Event cards require manual review/)
  assert.match(text, /shadow_read_event_convert_legacy_card_claim\(v_claim\.id\)/)
  assert.match(text, /v_cards IS DISTINCT FROM \(v_result ->> 'story_cards_added'\)::integer/)
})

test('participation bridge must use the same conversion helper', () => {
  const text = sql('shadow_read_event_participation_featured_card_bridge_v2.sql')
  assert.match(text, /shadow_read_event_convert_legacy_card_claim\(v_claim\.id\)/)
  assert.match(text, /IF v_converted <> v_awarded/)
})

test('backend routes have no additional deployment edits in staged test files', () => {
  const text = server()
  assert.match(text, /app\.use\('\/api\/read-event', shadowReadEventRoutes\)/)
  assert.match(text, /app\.use\('\/api\/read-event\/rewards', shadowReadEventRewardsRoutes\)/)
})
