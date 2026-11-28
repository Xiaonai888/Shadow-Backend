import test from 'node:test'
import assert from 'node:assert/strict'
import { createShadowGeminiDailyLearningLock as create } from './shadowGeminiDailyLearningLock.service.js'

function fixture(response, fail = false) {
  const calls = []
  const claim = create({ db: { rpc(name, args) { calls.push({ name, args }); return { async abortSignal(signal) { assert.ok(signal instanceof AbortSignal); if (fail) throw Error('private detail'); return response } } } } })
  return { claim, calls }
}
test('claim makes one bounded service RPC and preserves boolean', async () => {
  for (const data of [true, false]) {
    const { claim, calls } = fixture({ data, error: null })
    assert.equal(await claim({ day: '2026-11-28' }), data)
    assert.deepEqual(calls, [{ name: 'shadow_ai_gemini_claim_learning_day_v1', args: { p_day: '2026-11-28' } }])
  }
})
test('invalid dates never call database', async () => {
  const { claim, calls } = fixture({ data: true })
  for (const day of [null, undefined, '2026-02-30', '2026-11-28T02:00:00Z', '2026-1-01', {}, '2026-13-01']) await assert.rejects(claim({ day }), { code: 'SHADOW_AI_GEMINI_LEARNING_DAY_INVALID' })
  assert.deepEqual(calls, [])
})
test('lock fails closed on database or transport errors without retry', async () => {
  for (const [response, fail] of [[null, false], [{ data: 'true' }, false], [{ data: true, error: {} }, false], [null, true]]) {
    const { claim, calls } = fixture(response, fail)
    await assert.rejects(claim({ day: '2026-11-28' }), { code: 'SHADOW_AI_GEMINI_LEARNING_LOCK_UNAVAILABLE' })
    assert.equal(calls.length, 1)
  }
})
test('separate workers reuse same atomic claim contract with mocked persistent state', async () => {
  let last = null
  const db = { rpc(_name, { p_day }) { return { async abortSignal() { if (last !== null && p_day <= last) return { data: false }; last = p_day; return { data: true } } } } }
  assert.deepEqual(await Promise.all([create({ db })({ day: '2026-11-28' }), create({ db })({ day: '2026-11-28' })]), [true, false])
  assert.equal(await create({ db })({ day: '2026-11-28' }), false)
  assert.equal(await create({ db })({ day: '2026-11-29' }), true)
})
