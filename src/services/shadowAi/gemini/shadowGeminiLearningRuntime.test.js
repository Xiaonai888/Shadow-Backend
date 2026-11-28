import test from 'node:test'
import assert from 'node:assert/strict'
import { createShadowGeminiLearningRuntime } from './shadowGeminiLearningRuntime.service.js'
import { createShadowLocalKnowledgeDictionary } from '../local/shadowLocalKnowledge.js'
import { getShadowGeminiExample } from './shadowGeminiExamples.js'
import { shadowMatchKey } from '../local/shadowLocalText.js'

const env = Object.fromEntries(['SHADOW_GEMINI_BATCH_LEARNING_ENABLED','SHADOW_GEMINI_ENABLED','SHADOW_GEMINI_FREE_PROJECT_CONFIRMED','SHADOW_GEMINI_ADULT_ADMIN_TOOL_CONFIRMED'].map(k => [k,'true']))
const snapshot = { version: 3, aliases: [] }
function fixture({ failAt = null, flags = env, time = Date.parse('2026-11-28T19:00:00Z'), rows = new Map(), claimed = new Set() } = {}) {
  const calls = [], lessons = [], invalidations = [], timers = []
  const db = { rpc(name, args) { calls.push(name); return { async abortSignal(signal) {
    assert.ok(signal instanceof AbortSignal)
    if (failAt === name) return { error: { message: 'private' } }
    if (name.includes('list_learning')) return { data: [...rows.values()] }
    if (name.includes('claim_learning')) { const fresh = !claimed.has(args.p_day); claimed.add(args.p_day); return { data: fresh } }
    if (name.includes('save_learning')) {
      let inserted = 0
      for (const id of args.p_example_ids) if (!rows.has(id)) { rows.set(id, { example_id: id, expected_version: args.p_expected_version }); inserted++ }
      return { data: inserted }
    }
    if (name.includes('approve_learning')) {
      for (const id of args.p_example_ids) rows.delete(id)
      return { data: { ok: true, changed: true, version: args.p_expected_version + 1, approved_count: args.p_example_ids.length } }
    }
    throw Error('unexpected RPC')
  } } } }
  const knowledgeAdmin = { async read() { calls.push('snapshot'); return snapshot } }
  const management = { async status() { return { mode: 'synthetic_admin_only' } }, async testExample({ example_id }) {
    lessons.push(example_id)
    if (failAt === 'teacher' && lessons.length === 3) throw Error('private provider response')
    const question = example_id.split('_')[0]
    return { example_id, engine: 'gemini', external_requests: 1, dictionary_version: createShadowLocalKnowledgeDictionary(snapshot).version, question, candidate: { group: 'questions', alias: shadowMatchKey(getShadowGeminiExample(example_id)).replace(/[?？។!！]+$/u, '').trim(), canonical: question }, test_only: true, knowledge_published: false, reader_fallback_enabled: false }
  } }
  const runtime = createShadowGeminiLearningRuntime({ db, knowledgeAdmin, knowledgeStore: { invalidate: () => invalidations.push(true) }, management, env: flags, now: () => time, schedule(fn, delay) { const timer = { fn, delay, unref() {} }; timers.push(timer); return timer }, cancel() {} })
  return { runtime, calls, lessons, rows, claimed, invalidations, timers }
}
test('disabled and outside window do not read storage or contact teacher', async () => {
  for (const opts of [{ flags: {} }, { time: Date.parse('2026-11-28T18:00:00Z') }]) {
    const f = fixture(opts); assert.equal((await f.runtime.runDailyLearning()).attempts, 0); assert.deepEqual(f.calls, []); assert.deepEqual(f.lessons, [])
  }
})
test('five verified examples saved with one batch write and no publication', async () => {
  const f = fixture(); const r = await f.runtime.runDailyLearning()
  assert.equal(r.status, 'completed'); assert.equal(r.attempts, 5); assert.equal(r.candidates_created, 5); assert.equal(r.knowledge_published, false)
  assert.deepEqual(f.calls, ['snapshot','shadow_ai_gemini_list_learning_candidates_v1','shadow_ai_gemini_claim_learning_day_v1','shadow_ai_gemini_save_learning_candidates_v1']); assert.equal(f.rows.size, 5); assert.equal(f.invalidations.length, 0)
})
test('same-day restart cannot call teacher again and next day skips saved lessons', async () => {
  const a = fixture(); await a.runtime.runDailyLearning()
  const b = fixture({ rows: a.rows, claimed: a.claimed }); assert.equal((await b.runtime.runDailyLearning()).status, 'already_claimed'); assert.equal(b.lessons.length, 0)
  const c = fixture({ rows: a.rows, claimed: a.claimed, time: Date.parse('2026-11-29T19:00:00Z') }); await c.runtime.runDailyLearning(); assert.ok(c.lessons.every(id => !a.lessons.includes(id)))
})
test('partial verified batch survives teacher failure with no retry', async () => {
  const f = fixture({ failAt: 'teacher' }); const r = await f.runtime.runDailyLearning()
  assert.equal(r.status, 'teacher_stopped'); assert.equal(r.attempts, 3); assert.equal(r.candidates_created, 2); assert.equal(f.rows.size, 2); assert.doesNotMatch(JSON.stringify(r), /private/)
})
test('database failure stops external work or reports failed persistence', async () => {
  for (const failAt of ['shadow_ai_gemini_list_learning_candidates_v1','shadow_ai_gemini_claim_learning_day_v1','shadow_ai_gemini_save_learning_candidates_v1']) {
    const f = fixture({ failAt }); const r = await f.runtime.runDailyLearning(); assert.equal(r.candidates_created, 0); assert.equal(f.rows.size, 0)
    assert.equal(f.lessons.length, failAt.includes('save') ? 5 : 0)
    assert.equal(r.status, failAt.includes('save') ? 'candidate_stopped' : 'learning_unavailable')
  }
})
test('overlapping runs are bounded and only one saves', async () => {
  const f = fixture(); const a = f.runtime.runDailyLearning(); assert.equal((await f.runtime.runDailyLearning()).status, 'busy'); await a
  assert.equal(f.lessons.length, 5); assert.equal(f.calls.filter(n => n.includes('save_learning')).length, 1)
})
test('admin approval uses existing atomic RPC and invalidates only on success', async () => {
  const f = fixture(); await f.runtime.runDailyLearning(); const pending = await f.runtime.listCandidates(); assert.equal(pending.expected_version, 3); assert.equal(pending.candidates.length, 5)
  const id = pending.candidates[0].example_id
  await assert.rejects(f.runtime.approve('owner',{ expected_version: 3, example_ids: [id], approved: false }))
  assert.equal(f.invalidations.length, 0)
  const approved = await f.runtime.approve('owner',{ expected_version: 3, example_ids: [id], approved: true }); assert.equal(approved.version, 4); assert.equal(f.rows.has(id), false); assert.equal(f.invalidations.length, 1)
})
test('scheduler startup only arms timer, manual test shares management', async () => {
  const f = fixture(); assert.equal(f.runtime.start(), true); assert.equal(f.runtime.start(), false); assert.equal(f.timers.length, 1); assert.deepEqual(f.calls, []); assert.equal(f.lessons.length, 0)
  assert.equal((await f.runtime.status()).mode, 'synthetic_admin_only'); await f.runtime.testExample({ example_id: 'price_en' }); assert.deepEqual(f.lessons, ['price_en']); assert.equal(f.runtime.stop(), true)
})
