import test from 'node:test'
import assert from 'node:assert/strict'
import { createShadowGeminiLearningApproval } from './shadowGeminiLearningApproval.service.js'
import { createShadowGeminiPersistentCandidates } from './shadowGeminiPersistentCandidates.service.js'

const price = { group: 'questions', alias: 'what would one copy cost me', canonical: 'price' }
const stock = { group: 'questions', alias: 'are there any limited copies left to reserve', canonical: 'stock' }
const input = { approved: true, expected_version: 3, example_ids: ['price_en'] }
function fixture({ snapshot = { version: 3, aliases: [] }, rows = [{ example_id: 'price_en', expected_version: 2 }], response = { data: { ok: true, changed: true, version: 4, approved_count: 1 } } } = {}) {
  const calls = []; let invalidations = 0, reads = 0
  const db = { rpc(name, args) { calls.push({ name, args }); return { async abortSignal() { return name.includes('list_learning') ? { data: rows } : response } } } }
  const approve = createShadowGeminiLearningApproval({ db, candidates: createShadowGeminiPersistentCandidates({ db }), readSnapshot: async () => { reads++; return snapshot }, invalidate: () => { invalidations++ } })
  return { approve, calls, invalidations: () => invalidations, reads: () => reads }
}
test('explicit approval uses current reviewed version and one atomic write', async () => {
  const f = fixture()
  assert.deepEqual(await f.approve('owner', input), { version: 4, changed: true, approved_count: 1, knowledge_published: true, reader_fallback_enabled: false })
  assert.deepEqual(f.calls.at(-1), { name: 'shadow_ai_gemini_approve_learning_candidates_v1', args: { p_example_ids: ['price_en'], p_expected_version: 3, p_aliases: [price], p_admin_id: 'owner' } })
  assert.equal(f.calls.length, 2); assert.equal(f.invalidations(), 1)
})
test('bulk approval preserves old knowledge and deduplicates already known aliases', async () => {
  const f = fixture({ snapshot: { version: 3, aliases: [price] }, rows: [{ example_id: 'price_en', expected_version: 2 }, { example_id: 'stock_en', expected_version: 3 }], response: { data: { ok: true, changed: true, version: 4, approved_count: 2 } } })
  await f.approve('owner', { ...input, example_ids: ['stock_en', 'price_en'] })
  assert.deepEqual(f.calls.at(-1).args.p_aliases, [stock, price]); assert.equal(f.calls.length, 2)
})
test('unapproved, private, duplicate or extra input never reads or writes', async () => {
  const f = fixture()
  for (const bad of [{ ...input, approved: false }, { ...input, example_ids: ['private user text'] }, { ...input, example_ids: ['price_en','price_en'] }, { ...input, alias: price }, { ...input, expected_version: null }]) await assert.rejects(f.approve('owner', bad), { code: 'SHADOW_AI_GEMINI_APPROVAL_INVALID' })
  assert.equal(f.calls.length, 0); assert.equal(f.reads(), 0)
})
test('stale UI version stops before pending read or write', async () => {
  const f = fixture({ snapshot: { version: 4, aliases: [] } })
  await assert.rejects(f.approve('owner', input), { code: 'SHADOW_AI_GEMINI_APPROVAL_CONFLICT' }); assert.equal(f.calls.length, 0)
})
test('missing or future candidate prevents approval', async () => {
  for (const rows of [[], [{ example_id: 'price_en', expected_version: 4 }]]) {
    const f = fixture({ rows }); await assert.rejects(f.approve('owner', input), { code: 'SHADOW_AI_GEMINI_APPROVAL_CONFLICT' }); assert.equal(f.calls.length, 1)
  }
})
test('conflicting existing alias cannot be replaced', async () => {
  const f = fixture({ snapshot: { version: 3, aliases: [{ ...price, canonical: 'stock' }] } })
  await assert.rejects(f.approve('owner', input), { code: 'SHADOW_AI_GEMINI_APPROVAL_CONFLICT' }); assert.equal(f.calls.length, 1)
})
test('database conflict or failed result does not invalidate', async () => {
  for (const response of [{ data: { ok: false, code: 'SHADOW_AI_GEMINI_APPROVAL_CONFLICT' } }, { error: { message: 'private database error' } }, { data: { ok: true, changed: true, version: 4, approved_count: 0 } }]) {
    const f = fixture({ response }); await assert.rejects(f.approve('owner', input), { code: response.data?.ok === false ? 'SHADOW_AI_GEMINI_APPROVAL_CONFLICT' : 'SHADOW_AI_GEMINI_APPROVAL_UNAVAILABLE' }); assert.equal(f.invalidations(), 0)
  }
})
test('already known candidate can be cleared without creating a new version', async () => {
  const f = fixture({ snapshot: { version: 3, aliases: [price] }, response: { data: { ok: true, changed: false, version: 3, approved_count: 1 } } })
  assert.deepEqual(await f.approve('owner', input), { version: 3, changed: false, approved_count: 1, knowledge_published: false, reader_fallback_enabled: false })
})
