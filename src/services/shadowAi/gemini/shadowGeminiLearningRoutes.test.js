import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../../../routes/adminShadowGemini.routes.js', import.meta.url), 'utf8')
function fixture() {
  const routes = new Map(), middleware = [], calls = []
  const router = {
    use: fn => middleware.push(fn),
    get: (path, ...handlers) => routes.set(`GET ${path}`, handlers),
    post: (path, ...handlers) => routes.set(`POST ${path}`, handlers),
  }
  const express = { Router: () => router }
  const rateLimit = config => Object.assign((req, res, next) => next(), { config })
  const ipKeyGenerator = ip => ip
  const requireAdminPermission = permission => Object.assign((req, res, next) => req.allowed ? next() : res.status(403).json({ ok: false }), { permission })
  const shadowGeminiLearningInstance = Object.fromEntries(['status', 'testExample', 'listCandidates', 'approve'].map(name => [name, async (...args) => {
    calls.push({ name, args })
    if (name === 'approve' && args[1]?.expected_version === 99) throw Object.assign(new Error('private'), { code: 'SHADOW_AI_GEMINI_APPROVAL_CONFLICT', statusCode: 409 })
    return { method: name, reader_fallback_enabled: false }
  }]))
  const code = source.replace(/^import .*$/gm, '').replace('export default router', 'return router')
  const run = new Function('express', 'rateLimit', 'ipKeyGenerator', 'requireAdminPermission', 'shadowGeminiLearningInstance', code)
  assert.equal(run(express, rateLimit, ipKeyGenerator, requireAdminPermission, shadowGeminiLearningInstance), router)
  async function request(key, { allowed = true, role = 'owner', body } = {}) {
    const req = { ip: '127.0.0.1', admin: { admin_id: 'admin-real', role }, allowed, body }
    const out = { status: 200, headers: {}, body: null }
    const res = { set(k, v) { out.headers[k] = v; return this }, status(n) { out.status = n; return this }, json(data) { out.body = data; return this } }
    const chain = [...middleware, ...routes.get(key)]
    const next = () => chain.shift()?.(req, res, next)
    await next()
    return out
  }
  return { routes, calls, request }
}
test('shared singleton replaces duplicate management instance', () => {
  assert.match(source, /import \{ shadowGeminiLearningInstance \} from '\.\.\/services\/shadowAi\/gemini\/shadowGeminiLearningInstance\.service\.js'/u)
  assert.doesNotMatch(source, /createShadowGeminiManagement|runDailyLearning|\.start\(/u)
})
test('old and new routes preserve middleware order and limits', () => {
  const { routes } = fixture()
  assert.deepEqual([...routes.keys()], ['GET /status', 'POST /test', 'GET /learning/candidates', 'POST /learning/approve'])
  for (const [key, chain] of routes) {
    assert.equal(chain.length, 5)
    assert.equal(chain[0].config.limit, 20)
    assert.equal(chain[1].permission, 'system_control.manage')
    assert.equal(chain[3].config.limit, key.startsWith('GET') ? 10 : 5)
  }
})
test('all routes deny non-owner and missing permission before service', async () => {
  const f = fixture()
  for (const key of f.routes.keys()) {
    assert.equal((await f.request(key, { role: 'admin' })).status, 403)
    assert.equal((await f.request(key, { allowed: false })).status, 403)
  }
  assert.deepEqual(f.calls, [])
})
test('status and manual test keep old contract', async () => {
  const f = fixture()
  const status = await f.request('GET /status')
  assert.equal(status.body.ok, true)
  assert.equal(status.headers['Cache-Control'], 'private, no-store')
  assert.equal(status.headers.Vary, 'Authorization')
  const body = { example_id: 'price_en' }
  await f.request('POST /test', { body })
  assert.deepEqual(f.calls, [{ name: 'status', args: [] }, { name: 'testExample', args: [body] }])
})
test('owner can list and approve, admin identity comes from middleware', async () => {
  const f = fixture()
  const list = await f.request('GET /learning/candidates')
  assert.equal(list.body.ok, true)
  const body = { approved: true, expected_version: 1, example_ids: ['price_en'] }
  const result = await f.request('POST /learning/approve', { body })
  assert.equal(result.body.ok, true)
  assert.deepEqual(f.calls, [{ name: 'listCandidates', args: [] }, { name: 'approve', args: ['admin-real', body] }])
})
test('approval conflict reports safe code without private error', async () => {
  const f = fixture()
  const result = await f.request('POST /learning/approve', { body: { expected_version: 99 } })
  assert.equal(result.status, 409)
  assert.deepEqual(result.body, { ok: false, code: 'SHADOW_AI_GEMINI_APPROVAL_CONFLICT' })
})
