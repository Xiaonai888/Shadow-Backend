import test from 'node:test'
import assert from 'node:assert/strict'
import { planShadowGeminiDailyLearning as plan, shadowGeminiLearningWindow as window } from './shadowGeminiDailyLearningPlan.js'
import { getShadowGeminiExample } from './shadowGeminiExamples.js'
import { shadowMatchKey } from '../local/shadowLocalText.js'
const snapshot = { version: 1, aliases: [] }
const alias = id => shadowMatchKey(getShadowGeminiExample(id)).replace(/[?？។!！]+$/u, '').trim()
test('02:00 Cambodia is 19:00 UTC on the previous day', () => {
  assert.deepEqual(window(Date.parse('2026-11-28T19:00:00Z')), { day: '2026-11-29', due: true })
  assert.equal(window(Date.parse('2026-11-28T18:59:59Z')).due, false)
  assert.equal(window(Date.parse('2026-11-28T20:00:00Z')).due, false)
})
test('only a bounded group of known synthetic IDs can be planned', () => {
  const lessons = plan({ snapshot })
  assert.equal(lessons.length, 5)
  assert.equal(new Set(lessons).size, 5)
  assert.ok(lessons.every(id => id !== 'unclear_en' && getShadowGeminiExample(id)))
})
test('skip learned and pending aliases, even pending from earlier versions', () => {
  const lessons = plan({ snapshot })
  const [a, b] = lessons
  const next = plan({ snapshot: { version: 2, aliases: [{ group: 'questions', alias: alias(a), canonical: a.split('_')[0] }] }, pending: [{ key: `questions:${alias(b)}`, status: 'pending_review', expected_version: 1 }] })
  assert.ok(!next.includes(a) && !next.includes(b))
})
test('budget cannot exceed 20 and zero produces no lesson', () => {
  assert.deepEqual(plan({ snapshot, budget: 0 }), [])
  assert.equal(plan({ snapshot, budget: 1 }).length, 1)
  assert.throws(() => plan({ snapshot, budget: 21 }), TypeError)
})
