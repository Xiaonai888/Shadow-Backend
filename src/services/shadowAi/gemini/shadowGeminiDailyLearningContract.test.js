import test from 'node:test'
import assert from 'node:assert/strict'
import { createShadowGeminiDailyLearning } from './shadowGeminiDailyLearning.service.js'
import { planShadowGeminiDailyLearning } from './shadowGeminiDailyLearningPlan.js'
import { createShadowLocalLearningCandidates } from '../local/shadowLocalLearningCandidates.js'
import { getShadowGeminiExample } from './shadowGeminiExamples.js'
import { shadowMatchKey } from '../local/shadowLocalText.js'
import { createShadowLocalKnowledgeDictionary } from '../local/shadowLocalKnowledge.js'
const env = Object.fromEntries(['SHADOW_GEMINI_BATCH_LEARNING_ENABLED','SHADOW_GEMINI_ENABLED','SHADOW_GEMINI_FREE_PROJECT_CONFIRMED','SHADOW_GEMINI_ADULT_ADMIN_TOOL_CONFIRMED'].map(key => [key,'true']))
test('approved candidates can use existing versioned knowledge publication contract; no automatic publication', async () => {
  const snapshot = { version: 4, aliases: [] }, candidates = createShadowLocalLearningCandidates()
  const dictionary = createShadowLocalKnowledgeDictionary(snapshot)
  const run = createShadowGeminiDailyLearning({ env, now: () => Date.parse('2026-11-28T19:00:00Z'), readSnapshot: async () => snapshot, candidates, claimDay: async () => true, testExample: async ({ example_id }) => {
    const question = example_id.split('_')[0]
    return { example_id, engine: 'gemini', external_requests: 1, dictionary_version: dictionary.version, question, candidate: { group: 'questions', alias: shadowMatchKey(getShadowGeminiExample(example_id)).replace(/[?？។!！]+$/u, '').trim(), canonical: question }, test_only: true, knowledge_published: false, reader_fallback_enabled: false }
  } })
  await run()
  const candidate = candidates.list()[0]
  assert.equal(dictionary.lookup('questions', candidate.alias.alias), null)
  assert.throws(() => candidates.prepareApproval({ key: candidate.key, snapshot, approved: false }))
  const prepared = candidates.prepareApproval({ key: candidate.key, snapshot, approved: true })
  const next = createShadowLocalKnowledgeDictionary({ version: 5, aliases: prepared.aliases })
  assert.equal(next.lookup('questions', candidate.alias.alias), candidate.alias.canonical)
  assert.ok(!planShadowGeminiDailyLearning({ snapshot: { version: 5, aliases: prepared.aliases }, pending: candidates.list() }).includes('price_km'))
})
