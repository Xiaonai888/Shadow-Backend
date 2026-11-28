import test from 'node:test'
import assert from 'node:assert/strict'
import { createShadowGeminiLearningReview as create } from './shadowGeminiLearningReview.js'
import { createShadowLocalLearningCandidates } from '../local/shadowLocalLearningCandidates.js'
import { createShadowLocalKnowledgeDictionary } from '../local/shadowLocalKnowledge.js'

const snapshot = { version: 2, aliases: [] }
const row = { group: 'questions', alias: 'what would one copy cost me', canonical: 'price' }
const result = { example_id: 'price_en', test_only: true, knowledge_published: false, reader_fallback_enabled: false, dictionary_version: createShadowLocalKnowledgeDictionary(snapshot).version, engine: 'gemini', question: 'price', external_requests: 1, candidate: row }
function fixture(response = result) {
  const calls = []
  const candidates = createShadowLocalLearningCandidates()
  const run = create({ candidates, async readSnapshot() { calls.push('snapshot'); return snapshot }, async testExample(input) { calls.push(input); return response } })
  return { run, calls, candidates }
}
test('one existing test and one admin snapshot, then deduplicated candidate in RAM', async () => {
  const f = fixture()
  const first = await f.run({ example_id: 'price_en' })
  assert.equal(first.status, 'pending_review')
  assert.equal(first.knowledge_published, false)
  assert.deepEqual(f.calls, ['snapshot', { example_id: 'price_en' }])
  assert.deepEqual(first, await f.run({ example_id: 'price_en' }))
  assert.equal(f.candidates.list().length, 1)
})
test('arbitrary raw text, extra fields and invalid IDs cannot reach teacher', async () => {
  const f = fixture()
  for (const input of [null, {}, { example_id: 'private message' }, { example_id: 'price_en', message: 'private' }]) await assert.rejects(f.run(input), { code: 'SHADOW_AI_GEMINI_EXAMPLE_INVALID' })
  assert.deepEqual(f.calls, [])
})
test('incorrect classification is not proposed', async () => {
  const f = fixture({ ...result, question: 'stock' })
  assert.equal((await f.run({ example_id: 'price_en' })).status, 'category_mismatch')
  assert.deepEqual(f.candidates.list(), [])
})
test('stale dictionary is not proposed', async () => {
  const f = fixture({ ...result, dictionary_version: 'old' })
  assert.equal((await f.run({ example_id: 'price_en' })).status, 'stale_knowledge')
  assert.deepEqual(f.candidates.list(), [])
})
test('quota error propagates without retry or candidate', async () => {
  const candidates = createShadowLocalLearningCandidates()
  let calls = 0
  const run = create({ candidates, readSnapshot: async () => snapshot, async testExample() { calls++; throw Object.assign(new Error('quota'), { code: 'SHADOW_AI_GEMINI_QUOTA' }) } })
  await assert.rejects(run({ example_id: 'price_en' }), { code: 'SHADOW_AI_GEMINI_QUOTA' })
  assert.equal(calls, 1)
  assert.deepEqual(candidates.list(), [])
})
