import test from 'node:test'
import assert from 'node:assert/strict'
import { createShadowLocalTurnReasoning } from './shadowLocalTurnReasoning.js'
import { createShadowLocalLearningAccumulator } from './shadowLocalLearningAccumulator.js'

const context = { can_book: true, stock_verified: true, books: [], delivery_companies: [], signature_enabled: false }
const reason = createShadowLocalTurnReasoning({ mergeDraft: (_context, before, patch) => ({ ...before, ...patch }), inspectDraft: () => ({ ready: false, missing: ['name'], issues: [], pending_requirements: [] }) })
const run = parsed => reason({ parsed, context, before: {}, rules: [] })
test('observes actual reasoning corrections without another parser call or mutation', () => {
  const store = createShadowLocalLearningAccumulator()
  const output = run({ intent: 'booking', question: null, patch: { payment: 'paid' } })
  const before = JSON.stringify(output)
  assert.equal(store.observe(output).reason, 'invalid_or_conflicting_output')
  assert.equal(JSON.stringify(output), before)
  assert.deepEqual(output.draft, {})
})
test('normal question and booking progress are not pending learning candidates', () => {
  const store = createShadowLocalLearningAccumulator()
  for (const parsed of [{ intent: 'question', question: 'price', patch: {} }, { intent: 'booking', question: null, patch: { name: 'Reader' } }]) assert.equal(store.observe(run(parsed)).reason, 'handled')
  assert.equal(store.snapshot().counts.handled, 2)
  assert.deepEqual(store.snapshot().pending_review, [])
})
test('unclear turn yields a review category without retaining its draft', () => {
  const store = createShadowLocalLearningAccumulator()
  const output = run({ intent: 'unclear', question: null, patch: {} })
  store.observe({ ...output, draft: { name: 'PRIVATE' } })
  assert.equal(store.snapshot().pending_review[0].reason, 'unknown_intent')
  assert.doesNotMatch(JSON.stringify(store.snapshot()), /PRIVATE/)
})
