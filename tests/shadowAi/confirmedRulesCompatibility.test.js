import test from 'node:test'
import assert from 'node:assert/strict'
import { createShadowAiConfirmedRulesReader } from '../../src/services/shadowAi/shadowAiConfirmedRulesReader.service.js'
import { createShadowAiRequirementsStore, readShadowAiConfirmedRules } from '../../src/services/shadowAi/shadowAiPreOrderRequirementsStore.service.js'

const campaignId = '11111111-1111-1111-1111-111111111111'
const authorPageId = '22222222-2222-2222-2222-222222222222'
const owner = '33333333-3333-3333-3333-333333333333'
const scope = { campaignId, authorPageId }
const campaign = { id: campaignId, owner_user_id: owner, buyer_note_instruction: 'note' }
const row = { campaign_id: campaignId, source_instruction: 'note', confirmed_by: owner, confirmed_at: '2026-11-27T00:00:00Z', rules: [{ field: 'buyer_note', condition: 'always' }] }
function makeDb(c, r) {
  let count = 0
  return { count: () => count, from(table) {
    let joined = false
    return {
      select(fields) { joined = fields.includes('requirements:'); return this },
      eq() { return this },
      maybeSingle() { return this },
      async abortSignal() {
        count++
        const data = table === 'author_preorder_campaigns' ? joined && c ? { ...c, requirements: r } : c : r
        return { data, error: null }
      },
    }
  } }
}
for (const [name, c, r] of [
  ['confirmed with real normalization', campaign, row],
  ['missing campaign', null, row],
  ['missing confirmation', campaign, null],
  ['changed author instruction', { ...campaign, buyer_note_instruction: 'new note' }, row],
  ['different confirming owner', campaign, { ...row, confirmed_by: authorPageId }],
  ['empty rules', campaign, { ...row, rules: [] }],
  ['duplicate rules', campaign, { ...row, rules: [...row.rules, ...row.rules] }],
]) {
  test(`${name}: identical result with bounded query count`, async () => {
    const oldDb = makeDb(c, r), newDb = makeDb(c, r)
    const old = createShadowAiRequirementsStore({ db: oldDb })
    const load = createShadowAiConfirmedRulesReader({ db: newDb, readConfirmedRules: readShadowAiConfirmedRules })
    assert.deepEqual(await load(scope), await old.loadConfirmedRules(scope))
    assert.equal(oldDb.count(), c ? 2 : 1)
    assert.equal(newDb.count(), 1)
  })
}
test('invalid confirmed rule remains rejected by real validator', async () => {
  const bad = { ...row, rules: [{ field: 'password', condition: 'always' }] }
  const old = createShadowAiRequirementsStore({ db: makeDb(campaign, bad) })
  const load = createShadowAiConfirmedRulesReader({ db: makeDb(campaign, bad), readConfirmedRules: readShadowAiConfirmedRules })
  await assert.rejects(old.loadConfirmedRules(scope), { code: 'SHADOW_AI_REQUIREMENTS_INVALID' })
  await assert.rejects(load(scope), { code: 'SHADOW_AI_REQUIREMENTS_INVALID' })
})
