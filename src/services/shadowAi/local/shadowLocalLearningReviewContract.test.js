import test from 'node:test'
import assert from 'node:assert/strict'
import { createShadowLocalLearningCandidates } from './shadowLocalLearningCandidates.js'
import { createShadowLocalFeedback } from './shadowLocalFeedback.service.js'
import { createShadowLocalLearningAccumulator } from './shadowLocalLearningAccumulator.js'
import { createShadowLocalKnowledgeDictionary } from './shadowLocalKnowledge.js'

const scope = { actorUserId: '11111111-1111-4111-8111-111111111111', conversationId: '22222222-2222-4222-8222-222222222222', campaignId: '33333333-3333-4333-8333-333333333333' }
const snapshot = { version: 1, aliases: [] }
test('feedback and mistake counters cannot change dictionary', () => {
  const feedback = createShadowLocalFeedback(), learning = createShadowLocalLearningAccumulator(), candidates = createShadowLocalLearningCandidates()
  for (let i = 0; i < 100; i++) {
    feedback.submit({ token: feedback.issue(scope), scope, rating: 'incorrect' })
    learning.observe({ correction: { applied: false, reason: null }, confidence: { score_kind: 'rule_evidence_not_accuracy_probability', decision: 'clarify', intent_reason: 'unknown_intent', intent_score: 0 } })
  }
  assert.equal(feedback.snapshot().counts.incorrect, 100)
  assert.equal(learning.snapshot().pending_review[0].occurrences, 100)
  assert.deepEqual(candidates.list(), [])
  assert.equal(createShadowLocalKnowledgeDictionary(snapshot).lookup('questions', 'book pricing'), null)
})
test('review payload works with real knowledge validator, original snapshot unchanged', () => {
  const candidates = createShadowLocalLearningCandidates()
  const candidate = candidates.propose({ alias: { group: 'questions', alias: 'book pricing', canonical: 'price' }, snapshot, reviewedPublicPhrase: true })
  const proposed = candidates.prepareApproval({ key: candidate.key, snapshot, approved: true })
  assert.equal(proposed.expected_version, 1)
  assert.equal(createShadowLocalKnowledgeDictionary(snapshot).lookup('questions', 'book pricing'), null)
  assert.equal(createShadowLocalKnowledgeDictionary({ version: 2, aliases: proposed.aliases }).lookup('questions', 'book pricing'), 'price')
})
