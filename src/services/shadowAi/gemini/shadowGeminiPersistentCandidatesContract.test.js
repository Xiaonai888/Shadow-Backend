import test from 'node:test'
import assert from 'node:assert/strict'
import { createShadowGeminiPersistentCandidates } from './shadowGeminiPersistentCandidates.service.js'
import { planShadowGeminiDailyLearning } from './shadowGeminiDailyLearningPlan.js'
import { createShadowLocalKnowledgeDictionary } from '../local/shadowLocalKnowledge.js'
import { getShadowGeminiExample } from './shadowGeminiExamples.js'
import { shadowMatchKey } from '../local/shadowLocalText.js'

const snapshot = { version: 3, aliases: [] }
const resultFor = exampleId => ({ exampleId, result: { example_id: exampleId, test_only: true, knowledge_published: false, reader_fallback_enabled: false, engine: 'gemini', external_requests: 1, dictionary_version: createShadowLocalKnowledgeDictionary(snapshot).version, question: exampleId.split('_')[0], candidate: { group: 'questions', alias: shadowMatchKey(getShadowGeminiExample(exampleId)).replace(/[?？។!！]+$/u, '').trim(), canonical: exampleId.split('_')[0] } } })
function dbFixture() {
  const rows = new Map(), calls = []
  return { rows, calls, db: { rpc(name, args) { calls.push(name); return { async abortSignal() {
    if (name.includes('list')) return { data: [...rows.values()] }
    let inserted = 0
    for (const id of args.p_example_ids) if (!rows.has(id)) { rows.set(id, { example_id: id, expected_version: args.p_expected_version }); inserted++ }
    return { data: inserted }
  } } } } }
}
test('new service instance can load persisted candidates and skip repeat lessons', async () => {
  const { db, calls } = dbFixture(), first = createShadowGeminiPersistentCandidates({ db })
  const ids = planShadowGeminiDailyLearning({ snapshot })
  assert.equal(ids.length, 5)
  assert.equal((await first.saveBatch({ snapshot, results: ids.map(resultFor) })).inserted, 5)
  const restarted = createShadowGeminiPersistentCandidates({ db })
  const pending = await restarted.list()
  assert.equal(pending.length, 5)
  assert.ok(planShadowGeminiDailyLearning({ snapshot, pending }).every(id => !ids.includes(id)))
  assert.deepEqual(calls, ['shadow_ai_gemini_save_learning_candidates_v1', 'shadow_ai_gemini_list_learning_candidates_v1'])
  assert.ok(pending.every(row => createShadowLocalKnowledgeDictionary(snapshot).lookup('questions', row.alias.alias) === null))
})
test('duplicate batch does not overwrite original candidate version', async () => {
  const { db, rows } = dbFixture(), store = createShadowGeminiPersistentCandidates({ db })
  const row = resultFor('price_en')
  await store.saveBatch({ snapshot, results: [row] })
  const next = { version: 4, aliases: [] }
  const updated = { ...row, result: { ...row.result, dictionary_version: createShadowLocalKnowledgeDictionary(next).version } }
  assert.equal((await store.saveBatch({ snapshot: next, results: [updated] })).inserted, 0)
  assert.equal(rows.get('price_en').expected_version, 3)
})
