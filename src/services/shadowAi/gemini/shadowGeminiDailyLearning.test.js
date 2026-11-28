import test from 'node:test'
import assert from 'node:assert/strict'
import { createShadowGeminiDailyLearning as create } from './shadowGeminiDailyLearning.service.js'
import { createShadowLocalLearningCandidates } from '../local/shadowLocalLearningCandidates.js'
import { createShadowLocalKnowledgeDictionary } from '../local/shadowLocalKnowledge.js'
import { getShadowGeminiExample } from './shadowGeminiExamples.js'
import { shadowMatchKey } from '../local/shadowLocalText.js'

const env = Object.fromEntries(['SHADOW_GEMINI_BATCH_LEARNING_ENABLED', 'SHADOW_GEMINI_ENABLED', 'SHADOW_GEMINI_FREE_PROJECT_CONFIRMED', 'SHADOW_GEMINI_ADULT_ADMIN_TOOL_CONFIRMED'].map(key => [key, 'true']))
const snapshot = { version: 1, aliases: [] }
const dictionary = createShadowLocalKnowledgeDictionary(snapshot)
function fixture(overrides = {}) {
  const candidates = createShadowLocalLearningCandidates()
  const calls = [], claimed = new Set()
  const deps = { env, now: () => Date.parse('2026-11-28T19:00:00Z'), candidates,
    readSnapshot: async () => { calls.push('snapshot'); return snapshot },
    claimDay: async ({ day }) => { calls.push('claim'); if (claimed.has(day)) return false; claimed.add(day); return true },
    testExample: async ({ example_id }) => {
      calls.push(example_id)
      const question = example_id.split('_')[0]
      return { example_id, engine: 'gemini', external_requests: 1, dictionary_version: dictionary.version, question, candidate: { group: 'questions', alias: shadowMatchKey(getShadowGeminiExample(example_id)).replace(/[?？។!！]+$/u, '').trim(), canonical: question }, test_only: true, knowledge_published: false, reader_fallback_enabled: false }
    }, ...overrides }
  return { run: create(deps), candidates, calls, deps }
}
test('default off or outside window performs no IO', async () => {
  for (const opts of [{ env: {} }, { env: { ...env, SHADOW_GEMINI_FREE_PROJECT_CONFIRMED: 'false' } }, { now: () => Date.parse('2026-11-28T18:00:00Z') }]) {
    const f = fixture(opts); const result = await f.run(); assert.equal(result.attempts, 0); assert.deepEqual(f.calls, [])
  }
})
test('a batch reads one snapshot, claims once and only creates pending candidates', async () => {
  const f = fixture(); const result = await f.run()
  assert.equal(result.status, 'completed'); assert.equal(result.attempts, 5); assert.equal(result.reported_external_requests, 5); assert.equal(result.candidates_created, 5); assert.equal(result.knowledge_published, false)
  assert.equal(f.candidates.list().length, 5); assert.deepEqual(f.calls.slice(0, 2), ['snapshot','claim'])
  assert.equal(f.calls.length, 7)
})
test('shared durable claim dependency denies same-day rerun across runner instances', async () => {
  const f = fixture(); await f.run()
  const other = create(f.deps); const result = await other(); assert.equal(result.status, 'already_claimed'); assert.equal(result.attempts, 0)
})
test('concurrent invocations do not start duplicate calls', async () => {
  const f = fixture(); const first = f.run(); const second = await f.run(); assert.equal(second.status, 'busy'); await first
})
test('quota denial stops the batch without retry or leaked provider error', async () => {
  let calls = 0; const f = fixture({ testExample: async () => { calls++; throw Error('PRIVATE') } }); const result = await f.run()
  assert.equal(calls, 1); assert.equal(result.status, 'teacher_stopped'); assert.equal(result.attempts, 1); assert.equal(result.reported_external_requests, 0); assert.doesNotMatch(JSON.stringify(result), /PRIVATE/)
})
test('category mismatch stops and never proposes', async () => {
  const f = fixture({ testExample: async ({ example_id }) => ({ example_id, engine: 'gemini', external_requests: 1, dictionary_version: dictionary.version, question: 'unclear', candidate: null, test_only: true, knowledge_published: false, reader_fallback_enabled: false }) })
  const result = await f.run(); assert.equal(result.status, 'verification_stopped'); assert.equal(f.candidates.list().length, 0)
})
test('claim failure prevents any teacher attempt', async () => {
  const f = fixture({ claimDay: async () => { throw Error('DB failed') } }); const result = await f.run(); assert.equal(result.status, 'learning_unavailable'); assert.equal(result.attempts, 0)
})
