import test from 'node:test'
import assert from 'node:assert/strict'
import { createShadowGeminiManagement } from '../services/shadowAi/gemini/shadowGeminiManagement.service.js'
import { createShadowLocalKnowledgeDictionary } from '../services/shadowAi/local/shadowLocalKnowledge.js'

const env = { SHADOW_GEMINI_ENABLED: 'true', SHADOW_GEMINI_FREE_PROJECT_CONFIRMED: 'true', SHADOW_GEMINI_ADULT_ADMIN_TOOL_CONFIRMED: 'true', GEMINI_API_KEY: 'fake_test_key_not_real_secret', SHADOW_GEMINI_DAILY_LIMIT: '450' }
const now = Date.parse('2026-11-27T08:30:00Z')
function fixture({ settings = env, question = 'price', aliases = [], quota = true, row = { quota_day: '2026-11-27', day_count: 3, minute_started_at: '2026-11-27T08:29:45Z', minute_count: 2 }, rpcError = false } = {}) {
  const calls = []
  const db = {
    rpc(name, args) { calls.push(['rpc', name, args]); return { async abortSignal() { return { data: quota, error: rpcError ? {} : null } } } },
    from(name) { calls.push(['from', name]); return { select() { return this }, eq() { return this }, maybeSingle() { return this }, async abortSignal() { return { data: row, error: null } } } },
  }
  const dictionary = createShadowLocalKnowledgeDictionary({ version: 2, aliases })
  const service = createShadowGeminiManagement({ db, env: settings, now: () => now, knowledgeStore: { async getDictionary() { return dictionary } }, fetchImpl: async (url, req) => {
    calls.push(['fetch', url, JSON.parse(req.body)])
    return new Response(JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify({ question }) }] } }] }))
  } })
  return { service, calls }
}
test('status shows only local quota, no secret or external request', async () => {
  const f = fixture(); const r = await f.service.status()
  assert.equal(r.available, true); assert.equal(r.quota.remaining_local, 447); assert.equal(r.provider_quota_verified, false); assert.equal(r.reader_fallback_enabled, false); assert.equal(r.examples.length, 11); assert.equal(JSON.stringify(r).includes(env.GEMINI_API_KEY), false); assert.deepEqual(f.calls, [['from', 'shadow_ai_gemini_quota']])
})
test('disabled and missing quota are not ready', async () => {
  const a = await fixture({ settings: {} }).service.status(); assert.equal(a.available, false); assert.equal(a.reason, 'SHADOW_AI_GEMINI_ADULT_TOOL_REQUIRED')
  const b = await fixture({ row: null }).service.status(); assert.equal(b.available, false); assert.equal(b.reason, 'SHADOW_AI_GEMINI_QUOTA_UNAVAILABLE')
})
test('status resets stale day and minute without mutation', async () => {
  const f = fixture({ row: { quota_day: '2026-11-26', day_count: 450, minute_started_at: '2026-11-27T07:59:59Z', minute_count: 5 } }); const r = await f.service.status(); assert.equal(r.quota.reserved_today, 0); assert.equal(r.quota.reserved_this_window, 0); assert.equal(r.quota.remaining_local, 450); assert.equal(f.calls.length, 1)
})
test('known question uses local dictionary even without Gemini key', async () => {
  const f = fixture({ settings: {}, aliases: [{ group: 'questions', alias: 'what would one copy cost me', canonical: 'price' }] }); const r = await f.service.testExample({ example_id: 'price_en' }); assert.equal(r.engine, 'local'); assert.equal(r.external_requests, 0); assert.equal(r.question, 'price'); assert.deepEqual(f.calls, [])
})
test('unknown fixed question calls Gemini only after shared quota reservation', async () => {
  const f = fixture(); const r = await f.service.testExample({ example_id: 'price_en' }); assert.equal(r.engine, 'gemini'); assert.equal(r.external_requests, 1); assert.equal(r.knowledge_published, false); assert.deepEqual(r.candidate, { group: 'questions', alias: 'what would one copy cost me', canonical: 'price' }); assert.deepEqual(f.calls[0], ['rpc', 'shadow_ai_gemini_reserve_v1', { p_daily_limit: 450 }]); assert.equal(f.calls.length, 2)
})
test('unclear result never creates knowledge candidate', async () => {
  const f = fixture({ question: 'unclear' }); const r = await f.service.testExample({ example_id: 'unclear_en' }); assert.equal(r.candidate, null); assert.equal(r.knowledge_published, false)
})
test('arbitrary text and extra fields cannot enter teacher', async () => {
  const f = fixture(); for (const input of [{ example_id: 'private message' }, { example_id: 'price_en', text: 'private' }, { example_id: { id: 'price_en' } }, null]) await assert.rejects(f.service.testExample(input), { code: 'SHADOW_AI_GEMINI_EXAMPLE_INVALID' }); assert.deepEqual(f.calls, [])
})
test('adult tool confirmation and free project confirmation both required', async () => {
  const a = fixture({ settings: { ...env, SHADOW_GEMINI_ADULT_ADMIN_TOOL_CONFIRMED: 'false' } }); await assert.rejects(a.service.testExample({ example_id: 'price_en' }), { code: 'SHADOW_AI_GEMINI_ADULT_TOOL_REQUIRED' }); assert.deepEqual(a.calls, [])
  const b = fixture({ settings: { ...env, SHADOW_GEMINI_FREE_PROJECT_CONFIRMED: 'false' } }); await assert.rejects(b.service.testExample({ example_id: 'price_en' }), { code: 'SHADOW_AI_GEMINI_FREE_PROJECT_REQUIRED' }); assert.deepEqual(b.calls, [])
})
test('denied or unavailable quota prevents external requests', async () => {
  for (const [options, code] of [[{ quota: false }, 'SHADOW_AI_GEMINI_QUOTA'], [{ rpcError: true }, 'SHADOW_AI_GEMINI_QUOTA_UNAVAILABLE']]) { const f = fixture(options); await assert.rejects(f.service.testExample({ example_id: 'price_en' }), { code }); assert.equal(f.calls.length, 1); assert.equal(f.calls[0][0], 'rpc') }
})
