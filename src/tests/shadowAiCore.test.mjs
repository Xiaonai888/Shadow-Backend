import test from 'node:test'
import assert from 'node:assert/strict'
import { createShadowAiCore } from '../services/shadowAi/shadowAiCore.service.js'
import { shadowAiError } from '../services/shadowAi/shadowAiPolicy.js'

const actorUserId = '12345678-1234-1234-1234-123456789abc'
const request = { role: 'preorder', task: 'reader_message', actorUserId, input: { message: 'កក់សៀវភៅ ២ ក្បាល' }, schema: { type: 'object', properties: { quantity: { type: 'integer' } }, required: ['quantity'], additionalProperties: false } }
const env = { SHADOW_AI_ENABLED: 'true', SHADOW_AI_MODEL: 'test-model', OPENAI_API_KEY: 'test-key' }
const body = { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '{"quantity":2}' }] }], usage: { input_tokens: 15, output_tokens: 5 } }
function setup(overrides = {}) {
  const calls = []
  const run = createShadowAiCore({ env, reserve: async x => calls.push(['reserve', x]), finish: async x => calls.push(['finish', x]), fetchImpl: async (url, options) => { calls.push(['fetch', url, options]); return new Response(JSON.stringify(body)) }, ...overrides })
  return { run, calls }
}

test('disabled by default and no request is sent', async () => {
  const { run, calls } = setup({ env: {} })
  await assert.rejects(run(request), { code: 'SHADOW_AI_DISABLED' })
  assert.equal(calls.length, 0)
})

test('missing provider configuration blocks request', async () => {
  const { run, calls } = setup({ env: { SHADOW_AI_ENABLED: 'true' } })
  await assert.rejects(run(request), { code: 'SHADOW_AI_NOT_CONFIGURED' })
  assert.equal(calls.length, 0)
})

test('unapproved role and oversized message are blocked', async () => {
  const { run, calls } = setup()
  await assert.rejects(run({ ...request, role: 'discover' }), { code: 'SHADOW_AI_INVALID_REQUEST' })
  await assert.rejects(run({ ...request, input: { message: 'a'.repeat(12001) } }), { code: 'SHADOW_AI_INPUT_LIMIT' })
  assert.equal(calls.length, 0)
})

test('database denial blocks provider', async () => {
  const { run, calls } = setup({ reserve: async () => { throw shadowAiError('SHADOW_AI_DAILY_LIMIT', 'limit', 429) } })
  await assert.rejects(run(request), { code: 'SHADOW_AI_DAILY_LIMIT' })
  assert.equal(calls.length, 0)
})

test('reserves before provider, uses strict schema and records tokens', async () => {
  const { run, calls } = setup()
  const result = await run(request)
  assert.deepEqual(result.data, { quantity: 2 })
  assert.deepEqual(calls.map(x => x[0]), ['reserve', 'fetch', 'finish'])
  const payload = JSON.parse(calls[1][2].body)
  assert.equal(payload.store, false)
  assert.equal(payload.text.format.strict, true)
  assert.equal(payload.max_output_tokens, 900)
  assert.equal(payload.input[0].role, 'user')
  assert.equal(payload.tools, undefined)
  assert.equal(calls[2][1].requestId, result.requestId)
  assert.equal(calls[2][1].inputTokens, 15)
  assert.equal(calls[2][1].outputTokens, 5)
})

test('provider failure is counted and not retried', async () => {
  let attempts = 0
  const { run, calls } = setup({ fetchImpl: async () => { attempts++; return new Response('error', { status: 429 }) } })
  await assert.rejects(run(request), { code: 'SHADOW_AI_PROVIDER_LIMIT' })
  assert.equal(attempts, 1)
  assert.equal(calls.at(-1)[1].status, 'error')
})

test('incomplete or refused output is rejected', async () => {
  for (const response of [{ ...body, status: 'incomplete' }, { ...body, output: [{ type: 'message', role: 'assistant', content: [{ type: 'refusal' }] }] }]) {
    const { run, calls } = setup({ fetchImpl: async () => new Response(JSON.stringify(response)) })
    await assert.rejects(run(request), { code: response.status === 'incomplete' ? 'SHADOW_AI_INCOMPLETE' : 'SHADOW_AI_REFUSED' })
    assert.equal(calls.at(-1)[1].status, 'error')
  }
})

test('concurrent requests from the same actor are blocked and lock releases', async () => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  const { run } = setup({ fetchImpl: async () => { await gate; return new Response(JSON.stringify(body)) } })
  const first = run(request)
  await assert.rejects(run(request), { code: 'SHADOW_AI_BUSY' })
  release()
  await first
  await run(request)
})

test('usage completion failure prevents returning output', async () => {
  const { run } = setup({ finish: async () => { throw new Error('database down') } })
  await assert.rejects(run(request), { code: 'SHADOW_AI_USAGE_UNAVAILABLE' })
})
