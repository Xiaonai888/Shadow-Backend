import test from 'node:test'
import assert from 'node:assert/strict'
import { createShadowGeminiLearningReview } from './shadowGeminiLearningReview.js'
import { createShadowLocalLearningCandidates } from '../local/shadowLocalLearningCandidates.js'
import { createShadowLocalKnowledgeDictionary } from '../local/shadowLocalKnowledge.js'
import { getShadowGeminiExample } from './shadowGeminiExamples.js'
import { shadowMatchKey } from '../local/shadowLocalText.js'

const row = { group: 'questions', alias: 'what would one copy cost me', canonical: 'price' }
test('candidate approval remains separate and only published snapshot makes local reuse possible', async () => {
  let snapshot = { version: 2, aliases: [] }, external = 0
  const candidates = createShadowLocalLearningCandidates()
  const run = createShadowGeminiLearningReview({ candidates, readSnapshot: async () => snapshot, async testExample({ example_id }) {
    const dict = createShadowLocalKnowledgeDictionary(snapshot)
    const alias = shadowMatchKey(getShadowGeminiExample(example_id)).replace(/[?？។!！]+$/u, '').trim()
    const known = dict.lookup('questions', alias)
    if (!known) external++
    return { example_id, test_only: true, knowledge_published: false, reader_fallback_enabled: false, dictionary_version: dict.version, engine: known ? 'local' : 'gemini', question: known || 'price', external_requests: known ? 0 : 1, candidate: known ? null : row }
  } })
  const result = await run({ example_id: 'price_en' })
  assert.equal(result.status, 'pending_review')
  assert.equal(external, 1)
  assert.equal(createShadowLocalKnowledgeDictionary(snapshot).lookup('questions', row.alias), null)
  assert.throws(() => candidates.prepareApproval({ key: result.candidate.key, snapshot, approved: false }))
  const approval = candidates.prepareApproval({ key: result.candidate.key, snapshot, approved: true })
  assert.deepEqual(approval, { expected_version: 2, aliases: [row] })
  assert.equal(snapshot.version, 2)
  snapshot = { version: 3, aliases: approval.aliases }
  assert.equal((await run({ example_id: 'price_en' })).status, 'already_known')
  assert.equal(external, 1)
})
