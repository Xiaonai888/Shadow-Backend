import test from 'node:test'
import assert from 'node:assert/strict'
import { createShadowGeminiPersistentCandidates as create } from './shadowGeminiPersistentCandidates.service.js'
import { createShadowLocalKnowledgeDictionary } from '../local/shadowLocalKnowledge.js'
import { getShadowGeminiExample } from './shadowGeminiExamples.js'
import { shadowMatchKey } from '../local/shadowLocalText.js'

const snapshot = { version: 3, aliases: [] }
function lesson(exampleId = 'price_en', source = snapshot) {
  const question = exampleId.split('_')[0]
  return { exampleId, result: { example_id: exampleId, test_only: true, knowledge_published: false, reader_fallback_enabled: false, engine: 'gemini', external_requests: 1, dictionary_version: createShadowLocalKnowledgeDictionary(source).version, question, candidate: { group: 'questions', alias: shadowMatchKey(getShadowGeminiExample(exampleId)).replace(/[?？។!！]+$/u, '').trim(), canonical: question } } }
}
function fixture({ rows = [], failure = false, insertResult } = {}) {
  const calls = []
  const db = { rpc(name, args) { calls.push({ name, args }); return { async abortSignal() {
    if (failure) return { error: { message: 'private database detail' } }
    return { data: name.includes('list') ? rows : insertResult ?? args.p_example_ids.length }
  } } } }
  return { store: create({ db }), calls }
}
test('batch stores only deduplicated example IDs and version in one RPC', async () => {
  const { store, calls } = fixture()
  assert.deepEqual(await store.saveBatch({ snapshot, results: [lesson(), lesson(), lesson('stock_en')] }), { inserted: 2, knowledge_published: false })
  assert.deepEqual(calls, [{ name: 'shadow_ai_gemini_save_learning_candidates_v1', args: { p_example_ids: ['price_en','stock_en'], p_expected_version: 3 } }])
})
test('empty batch does not write', async () => {
  const { store, calls } = fixture()
  assert.deepEqual(await store.saveBatch({ snapshot, results: [] }), { inserted: 0, knowledge_published: false })
  assert.equal(calls.length, 0)
})
test('already published knowledge does not write', async () => {
  const { store, calls } = fixture(), source = { version: 4, aliases: [lesson().result.candidate] }
  const row = lesson('price_en', source)
  row.result = { ...row.result, engine: 'local', external_requests: 0, candidate: null }
  assert.equal((await store.saveBatch({ snapshot: source, results: [row] })).inserted, 0)
  assert.equal(calls.length, 0)
})
test('invalid or stale teacher results fail the whole batch without writes', async () => {
  const { store, calls } = fixture()
  const bad = lesson('stock_en'); bad.result.question = 'price'
  for (const row of [bad, lesson('price_en', { ...snapshot, version: 2 }), { ...lesson(), exampleId: 'private reader text' }, { ...lesson(), extra: true }]) {
    await assert.rejects(store.saveBatch({ snapshot, results: [lesson(), row] }), { code: 'SHADOW_AI_GEMINI_CANDIDATE_INVALID' })
  }
  assert.equal(calls.length, 0)
})
test('rejects batches above five and invalid snapshot versions', async () => {
  const { store, calls } = fixture()
  await assert.rejects(store.saveBatch({ snapshot, results: Array.from({ length: 6 }, () => lesson()) }), { code: 'SHADOW_AI_GEMINI_CANDIDATE_INVALID' })
  await assert.rejects(store.saveBatch({ snapshot: { version: 2147483648, aliases: [] }, results: [] }), { code: 'SHADOW_AI_GEMINI_CANDIDATE_INVALID' })
  assert.equal(calls.length, 0)
})
test('list reconstructs only fixed synthetic phrases and planner metadata', async () => {
  const { store, calls } = fixture({ rows: [{ example_id: 'price_en', expected_version: 3 }] })
  assert.deepEqual(await store.list(), [{ example_id: 'price_en', key: 'questions:what would one copy cost me', alias: lesson().result.candidate, expected_version: 3, status: 'pending_review' }])
  assert.equal(calls.length, 1)
})
test('invalid storage rows fail closed', async () => {
  for (const rows of [[{ example_id: 'private text', expected_version: 3 }], [{ example_id: 'price_en', expected_version: 0 }], [{ example_id: 'price_en', expected_version: 3, extra: true }], Array(2).fill({ example_id: 'price_en', expected_version: 3 }), null]) {
    await assert.rejects(fixture({ rows }).store.list(), { code: 'SHADOW_AI_GEMINI_CANDIDATE_STORAGE_UNAVAILABLE' })
  }
})
test('database errors and invalid insert counts fail closed without leaking raw errors', async () => {
  await assert.rejects(fixture({ failure: true }).store.list(), { code: 'SHADOW_AI_GEMINI_CANDIDATE_STORAGE_UNAVAILABLE', message: 'SHADOW_AI_GEMINI_CANDIDATE_STORAGE_UNAVAILABLE' })
  for (const insertResult of [-1, 2, '1']) await assert.rejects(fixture({ insertResult }).store.saveBatch({ snapshot, results: [lesson()] }), { code: 'SHADOW_AI_GEMINI_CANDIDATE_STORAGE_UNAVAILABLE' })
})
