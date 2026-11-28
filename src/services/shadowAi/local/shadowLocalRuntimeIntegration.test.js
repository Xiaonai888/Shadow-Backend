import test from 'node:test'
import assert from 'node:assert/strict'
import { createShadowLocalRuntime } from './shadowLocalRuntime.service.js'
import { createShadowLocalDictionary } from './shadowLocalDictionary.js'
import { interpretShadowLocalFollowup } from './shadowLocalFollowup.js'

const actor = '11111111-1111-4111-8111-111111111111'
const other = '22222222-2222-4222-8222-222222222222'
const id = '33333333-3333-4333-8333-333333333333'
const catalog = { books: [{ id, title: 'Moon', editions: ['standard', 'limited'] }], delivery_companies: [], signature_enabled: true }
const draft = { items: [{ book_id: id, edition: null, quantity: null }] }
const env = { SHADOW_AI_ENABLED: 'true', SHADOW_AI_ENGINE: 'local' }
const dictionary = createShadowLocalDictionary()
const request = (message, current_draft = {}) => ({ role: 'preorder', task: 'reader_message', actorUserId: actor, input: { message, current_draft, catalog }, schema: { type: 'object', additionalProperties: false } })
const author = () => ({ ...request(''), task: 'author_requirements', input: { instruction: 'require telegram for limited' } })
const readerContext = { scope: { actorUserId: actor, authorPageId: other, campaignId: id, conversationId: '44444444-4444-4444-8444-444444444444' }, revision: null }
function fixture(options = {}) {
  const calls = []
  const run = createShadowLocalRuntime({ env, reserve: async value => { calls.push(['reserve', value]); if (options.deny) throw Object.assign(new Error('Denied'), { code: 'SHADOW_AI_DAILY_LIMIT', statusCode: 429 }) }, finish: async value => { calls.push(['finish', value]); if (options.finishError) throw Error('failed') }, knowledgeStore: { async getDictionary() { calls.push(['dictionary']); return dictionary } }, ...options.extra })
  return { run, calls }
}
test('old reader output and usage reservation remain identical for existing messages', async () => {
  const f = fixture()
  for (const [message, current] of [['price', {}], ['Limited', draft], ['២ក្បាល', draft], ['my name is Test Buyer', {}], ['ship to Phnom Penh', {}], ['2', draft], ['3 copies', { items: [{ book_id: id, edition: 'standard', quantity: 2 }] }]]) {
    const req = request(message, current)
    const result = await f.run(req)
    assert.deepEqual(result.data, interpretShadowLocalFollowup(req.input, dictionary))
    assert.equal(result.engine, 'local')
    assert.equal(result.usage.inputTokens, null)
    assert.equal(result.dictionaryVersion, dictionary.version)
  }
  assert.equal(f.calls.filter(c => c[0] === 'reserve').length, 7)
  assert.equal(f.calls.filter(c => c[0] === 'finish').length, 7)
})
test('quota denial stops before dictionary or interpreter', async () => {
  const f = fixture({ deny: true }); await assert.rejects(f.run(request('price')), { code: 'SHADOW_AI_DAILY_LIMIT' }); assert.deepEqual(f.calls.map(c => c[0]), ['reserve'])
})
test('finish failure still fails closed', async () => {
  const f = fixture({ finishError: true }); await assert.rejects(f.run(request('price')), { code: 'SHADOW_AI_USAGE_UNAVAILABLE' }); await assert.rejects(f.run(request('price')), { code: 'SHADOW_AI_USAGE_UNAVAILABLE' })
})
test('same actor blocked and two global slots enforced', async () => {
  let release; const gate = new Promise(resolve => { release = resolve }); const f = fixture({ extra: { reserve: () => gate } })
  const first = f.run(request('price')); await assert.rejects(f.run(request('price')), { code: 'SHADOW_AI_BUSY' }); const second = f.run({ ...request('price'), actorUserId: other }); await assert.rejects(f.run({ ...request('price'), actorUserId: id }), { code: 'SHADOW_AI_BUSY' }); release(); await Promise.all([first, second])
})
test('new polite and context understanding needs one dictionary read per invocation', async () => {
  const f = fixture(); assert.equal((await f.run(request('please tell me price'))).data.question, 'price'); assert.deepEqual((await f.run(request('take limited 2 copies', draft))).data.items, [{ book_id: id, edition: 'limited', quantity: 2 }]); assert.equal(f.calls.filter(c => c[0] === 'dictionary').length, 2); assert.equal(f.calls.filter(c => c[0] === 'reserve').length, 2); assert.equal(f.calls.filter(c => c[0] === 'finish').length, 2)
})
test('author requirements do not read reader dictionary', async () => {
  const f = fixture(); const result = await f.run(author()); assert.deepEqual(result.data, { rules: [{ field: 'telegram_username', condition: 'limited' }], needs_review: [] }); assert.equal(result.dictionaryVersion, 'shadow-local-requirements-km-en-v1'); assert.deepEqual(f.calls.map(c => c[0]), ['reserve', 'finish'])
})
test('trusted context goes only to injected reader interpreter', async () => {
  let received; const f = fixture({ extra: { interpretReader(input, dict, context) { received = context; return interpretShadowLocalFollowup(input, dict) } } }); await f.run(request('price'), readerContext); assert.deepEqual(received, readerContext); await f.run({ ...request('price'), readerContext }); assert.equal(received, undefined)
})
test('cross actor and invalid contexts are rejected before quota reservation', async () => {
  const f = fixture(); for (const context of [{ ...readerContext, scope: { ...readerContext.scope, actorUserId: other } }, { ...readerContext, revision: -1 }, { scope: { actorUserId: actor }, revision: null }]) await assert.rejects(f.run(request('price'), context), { code: 'SHADOW_AI_INVALID_REQUEST' }); await assert.rejects(f.run(author(), readerContext), { code: 'SHADOW_AI_INVALID_REQUEST' }); assert.deepEqual(f.calls, [])
})
test('malformed catalog remains unclear and no external network is used', async () => {
  const f = fixture(); const old = globalThis.fetch; globalThis.fetch = () => { throw Error('network forbidden') }; try { const req = request('please tell me price'); delete req.input.catalog; assert.equal((await f.run(req)).data.intent, 'unclear'); assert.equal((await f.run(request('repeat the last answer'))).data.intent, 'unclear'); } finally { globalThis.fetch = old }
})
