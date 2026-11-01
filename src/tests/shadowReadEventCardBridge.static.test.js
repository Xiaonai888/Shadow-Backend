import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const root = new URL('../sql/', import.meta.url)
const sql = (name) => readFileSync(new URL(name, root), 'utf8')

const scripts = [
  'shadow_read_event_card_cutover_preflight_v1.sql',
  'shadow_read_event_card_bridge_helpers_v1.sql',
  'shadow_read_event_overall_featured_card_bridge_v2.sql',
  'shadow_read_event_participation_featured_card_bridge_v2.sql',
]

test('all bridge scripts are explicit transactions and service-only RPCs', () => {
  for (const filename of scripts) {
    const content = sql(filename)
    assert.match(content, /^BEGIN;\s/m)
    assert.match(content, /\bCOMMIT;\s*$/m)
    assert.match(content, /SECURITY DEFINER/)
    assert.match(content, /SET search_path = ''/)
    assert.match(content, /REVOKE ALL ON FUNCTION/)
    assert.match(content, /TO service_role/)
  }
})

test('cutover preflight remains read-only', () => {
  const source = sql(scripts[0])
  assert.match(source, /requires_manual_reconciliation/)
  assert.match(source, /safe_for_bridge_payout/)
  assert.doesNotMatch(source, /\bUPDATE\s+public\./i)
  assert.doesNotMatch(source, /\bINSERT\s+INTO\s+public\./i)
})

test('shared bridge moves legacy cards to the featured ledger atomically', () => {
  const source = sql(scripts[1])
  assert.match(source, /shadow_read_event_credit_featured_cards\(p_claim_id\)/)
  assert.match(source, /story_card_balance\s*=\s*COALESCE\(w\.story_card_balance,\s*0\)\s*-\s*v_claim\.card_amount/)
  assert.match(source, /IF v_wallet_rows <> 1 THEN/)
})

test('both payout wrappers retain old RPC names, lock and reject mixed historic credits', () => {
  for (const filename of scripts.slice(2)) {
    const source = sql(filename)
    assert.match(source, /shadow_read_event_overall_settlement:/)
    assert.match(source, /Historical uncredited Read Event cards require manual review/)
    assert.match(source, /shadow_read_event_convert_legacy_card_claim/)
    assert.match(source, /RAISE EXCEPTION '.*Featured Card payout mismatch'/)
    assert.match(source, /\bCREATE OR REPLACE FUNCTION public\.shadow_read_event_settle_/)
  }
})
