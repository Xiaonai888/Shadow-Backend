import test from 'node:test'
import assert from 'node:assert/strict'
import { createShadowGeminiDailyLearningScheduler as create, nextShadowGeminiLearningDelay as delay } from './shadowGeminiDailyLearningScheduler.js'

const flags = { SHADOW_GEMINI_BATCH_LEARNING_ENABLED: 'true', SHADOW_GEMINI_ENABLED: 'true', SHADOW_GEMINI_FREE_PROJECT_CONFIRMED: 'true', SHADOW_GEMINI_ADULT_ADMIN_TOOL_CONFIRMED: 'true' }
const ms = text => Date.parse(text)
const flush = () => new Promise(resolve => setImmediate(resolve))
function fixture({ time = '2026-11-28T01:59:00+07:00', env = { ...flags }, run } = {}) {
  let now = ms(time), calls = 0, unrefs = 0
  const timers = new Set(), errors = []
  const scheduler = create({ env, now: () => now, runDailyLearning: async () => { calls++; return run ? run() : { status: 'completed' } }, schedule(fn, wait) { const token = { fn, wait, unref() { unrefs++ } }; timers.add(token); return token }, cancel(token) { timers.delete(token) }, onError: event => errors.push(event) })
  return { scheduler, timers, errors, env, calls: () => calls, unrefs: () => unrefs, setTime: text => { now = ms(text) }, async fire(text) { if (text) now = ms(text); const token = [...timers][0]; assert.ok(token); timers.delete(token); token.fn(); await flush() } }
}
test('local 02:00 window and next-day timing', () => {
  assert.equal(delay(ms('2026-11-28T01:59:00+07:00')), 60000)
  assert.equal(delay(ms('2026-11-28T02:00:00+07:00')), 0)
  assert.equal(delay(ms('2026-11-28T02:59:59+07:00')), 0)
  assert.equal(delay(ms('2026-11-28T02:00:00+07:00'), '2026-11-28'), 86400000)
  assert.equal(delay(ms('2026-11-28T03:00:00+07:00')), 23 * 3600000)
})
test('disabled is inert and start is idempotent', () => {
  const disabled = fixture({ env: {} }); assert.equal(disabled.scheduler.start(), false); assert.equal(disabled.timers.size, 0)
  const f = fixture(); assert.equal(f.scheduler.start(), true); assert.equal(f.scheduler.start(), false); assert.equal(f.timers.size, 1); assert.equal(f.unrefs(), 1); assert.equal(f.calls(), 0)
})
test('one run each day; no per-minute polling', async () => {
  const f = fixture(); f.scheduler.start()
  await f.fire('2026-11-28T02:00:00+07:00')
  assert.equal(f.calls(), 1); assert.equal([...f.timers][0].wait, 86400000)
  await f.fire('2026-11-29T02:00:00+07:00'); assert.equal(f.calls(), 2); assert.equal(f.timers.size, 1)
})
test('startup within window runs once, restarting instance in same process does not repeat', async () => {
  const f = fixture({ time: '2026-11-28T02:25:00+07:00' }); f.scheduler.start(); assert.equal([...f.timers][0].wait, 0)
  await f.fire(); f.scheduler.stop(); f.scheduler.start(); assert.equal(f.calls(), 1); assert.ok([...f.timers][0].wait > 0)
})
test('late wake outside window skips and schedules next day', async () => {
  const f = fixture(); f.scheduler.start(); await f.fire('2026-11-28T03:05:00+07:00'); assert.equal(f.calls(), 0); assert.equal([...f.timers][0].wait, 22 * 3600000 + 55 * 60000)
})
test('failure reports only fixed code, no immediate retry', async () => {
  const f = fixture({ run: async () => { throw Error('secret') } }); f.scheduler.start(); await f.fire('2026-11-28T02:00:00+07:00'); assert.equal(f.calls(), 1); assert.deepEqual(f.errors, [{ code: 'SHADOW_AI_GEMINI_DAILY_LEARNING_FAILED' }]); assert.equal([...f.timers][0].wait, 86400000)
})
test('stop cancels old callback and disabling before wake prevents work', async () => {
  const f = fixture(); f.scheduler.start(); const old = [...f.timers][0]; f.scheduler.stop(); assert.equal(f.timers.size, 0); f.scheduler.start(); old.fn(); await flush(); assert.equal(f.calls(), 0); assert.equal(f.timers.size, 1); f.env.SHADOW_GEMINI_ENABLED = 'false'; await f.fire('2026-11-28T02:00:00+07:00'); assert.equal(f.calls(), 0); assert.equal(f.timers.size, 0)
})
test('no overlap if stopped and started during running task', async () => {
  let release; const gate = new Promise(resolve => { release = resolve })
  const f = fixture({ run: () => gate }); f.scheduler.start(); await f.fire('2026-11-28T02:00:00+07:00'); f.scheduler.stop(); f.scheduler.start(); assert.equal(f.calls(), 1); assert.equal(f.timers.size, 0); release({ status: 'completed' }); await flush(); assert.equal(f.timers.size, 1); assert.equal(f.calls(), 1)
})
