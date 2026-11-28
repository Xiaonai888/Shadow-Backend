import test from 'node:test'
import assert from 'node:assert/strict'
import { createShadowAiConfirmedRulesReader } from '../../src/services/shadowAi/shadowAiConfirmedRulesReader.service.js'

const campaignId = '11111111-1111-1111-1111-111111111111'
const authorPageId = '22222222-2222-2222-2222-222222222222'
const owner = '33333333-3333-3333-3333-333333333333'
const scope = { campaignId, authorPageId }
const row = { campaign_id: campaignId, source_instruction: 'note', confirmed_by: owner, confirmed_at: '2026-11-27T00:00:00Z', rules: [] }
const campaign = { id: campaignId, owner_user_id: owner, buyer_note_instruction: 'note', requirements: row }
function mock(data, error = null) {
  const calls = []
  const query = {
    select(value) { calls.push(['select', value]); return this },
    eq(key, value) { calls.push(['eq', key, value]); return this },
    maybeSingle() { calls.push(['maybeSingle']); return this },
    async abortSignal(signal) { assert.ok(signal instanceof AbortSignal); calls.push(['execute']); return { data, error } },
  }
  return { calls, db: { from(table) { calls.push(['from', table]); return query } } }
}
function setup(data, error) {
  const { db, calls } = mock(data, error)
  const checked = []
  const load = createShadowAiConfirmedRulesReader({ db, readConfirmedRules(c, r) { checked.push([c, r]); return { confirmed: !!r, rules: r?.rules ?? [] } } })
  return { load, calls, checked }
}
test('one scoped query and explicit FK, fields and timeout', async () => {
  const { load, calls, checked } = setup(campaign)
  assert.deepEqual(await load(scope), { confirmed: true, rules: [] })
  assert.equal(calls.filter(x => x[0] === 'execute').length, 1)
  assert.deepEqual(calls[0], ['from', 'author_preorder_campaigns'])
  assert.equal(calls[1][1], 'id,owner_user_id,buyer_note_instruction,requirements:shadow_ai_preorder_requirements!shadow_ai_preorder_requirements_campaign_id_fkey(campaign_id,source_instruction,rules,confirmed_by,confirmed_at)')
  assert.deepEqual(calls.filter(x => x[0] === 'eq'), [['eq', 'id', campaignId], ['eq', 'author_page_id', authorPageId]])
  assert.deepEqual(checked, [[campaign, row]])
})
test('absent campaign is unconfirmed and does not call validator', async () => {
  const { load, calls, checked } = setup(null)
  assert.deepEqual(await load(scope), { confirmed: false, rules: [] })
  assert.equal(checked.length, 0)
  assert.equal(calls.filter(x => x[0] === 'execute').length, 1)
})
test('absent relation is passed as null for old validator', async () => {
  for (const requirements of [null, []]) {
    const { load, checked } = setup({ ...campaign, requirements })
    assert.deepEqual(await load(scope), { confirmed: false, rules: [] })
    assert.equal(checked[0][1], null)
  }
})
test('single-row array representation is accepted', async () => {
  const { load, checked } = setup({ ...campaign, requirements: [row] })
  assert.equal((await load(scope)).confirmed, true)
  assert.equal(checked[0][1], row)
})
test('invalid ID fails before database', async () => {
  const { load, calls } = setup(campaign)
  await assert.rejects(load({ ...scope, campaignId: 'bad' }), { code: 'SHADOW_AI_SESSION_INVALID' })
  await assert.rejects(load({ ...scope, authorPageId: 'bad' }), { code: 'SHADOW_AI_SESSION_INVALID' })
  assert.equal(calls.length, 0)
})
test('query error is fail-closed, no retries or fallback', async () => {
  const { load, calls, checked } = setup(campaign, { code: 'PGRST200' })
  await assert.rejects(load(scope), { code: 'SHADOW_AI_REQUIREMENTS_STORAGE_UNAVAILABLE' })
  assert.equal(calls.filter(x => x[0] === 'execute').length, 1)
  assert.equal(checked.length, 0)
})
test('malformed or cross-campaign relationship is rejected', async () => {
  for (const data of [undefined, [], { ...campaign, id: owner }, { id: campaignId }, { ...campaign, requirements: [row, row] }, { ...campaign, requirements: { ...row, campaign_id: owner } }, { ...campaign, requirements: {} }, { ...campaign, requirements: 'invalid' }]) {
    const { load, checked } = setup(data)
    await assert.rejects(load(scope), { code: 'SHADOW_AI_REQUIREMENTS_STORAGE_UNAVAILABLE' })
    assert.equal(checked.length, 0)
  }
})
