import assert from 'node:assert/strict'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { runInNewContext } from 'node:vm'

const file = new URL('../src/services/criticalCircuitCanary.service.js', import.meta.url)
const source = readFileSync(file, 'utf8')
const active = [{ id: 'circuit-1', target_type: 'api', source: 'ALL', method: 'GET', path: '/api/test/canary', mode: 'automatic', expires_at: null }]
let now = 1000000
const clock = class extends Date { static now() { return now } }
const sandbox = {
  createHash, randomBytes, timingSafeEqual,
  jwt: { verify(token) { if (token !== 'owner-token') throw new Error('Invalid token'); return { role: 'owner', session_id: 'session-1' } } },
  getActiveWorkKillSwitchSnapshot: () => active,
  isKillSwitchBootstrapVerified: () => true,
  publishSecurityEvent: () => {},
  process: { env: { JWT_SECRET: 'test-secret' } },
  Date: clock,
}
const executable = source.replace(/^import .*\n/gm, '').replace(/^export /gm, '')
runInNewContext(`${executable}\nglobalThis.testAPI = { startCriticalCanary, getCriticalCanaryStatus, tryCriticalCanaryRequest, criticalCanaryReadyForRelease, clearCriticalCanary }`, sandbox)
const api = sandbox.testAPI
const target = { method: 'GET', path: '/api/test/canary' }
const owner = { role: 'owner', session_id: 'session-1' }
const req = (token) => ({ method: 'GET', headers: { authorization: 'Bearer owner-token', 'x-shadow-circuit-canary': token } })
const response = (statusCode) => Object.assign(new EventEmitter(), { statusCode, setHeader() {} })

assert.throws(() => api.startCriticalCanary({ ...target, owner: { role: 'admin', session_id: 'session-1' } }))
let trial = api.startCriticalCanary({ ...target, owner })
assert.equal(api.tryCriticalCanaryRequest({ req: req('invalid'), res: response(200), record: active[0], path: target.path }), false)
assert.equal(api.criticalCanaryReadyForRelease(target), false)
let res = response(302)
assert.equal(api.tryCriticalCanaryRequest({ req: req(trial.canary_token), res, record: active[0], path: target.path }), true)
assert.equal(api.tryCriticalCanaryRequest({ req: req(trial.canary_token), res: response(200), record: active[0], path: target.path }), false)
res.emit('finish')
assert.equal(api.getCriticalCanaryStatus(target).state, 'failed')
assert.equal(api.criticalCanaryReadyForRelease(target), false)
trial = api.startCriticalCanary({ ...target, owner })
for (let i = 0; i < 2; i += 1) {
  res = response(200)
  assert.equal(api.tryCriticalCanaryRequest({ req: req(trial.canary_token), res, record: active[0], path: target.path }), true)
  res.emit('finish')
}
assert.equal(api.getCriticalCanaryStatus(target).state, 'ready')
assert.equal(api.criticalCanaryReadyForRelease(target), true)
now += 5 * 60 * 1000 + 1
assert.equal(api.criticalCanaryReadyForRelease(target), false)
trial = api.startCriticalCanary({ ...target, owner })
res = response(200)
assert.equal(api.tryCriticalCanaryRequest({ req: req(trial.canary_token), res, record: active[0], path: target.path }), true)
assert.throws(() => api.startCriticalCanary({ ...target, owner }))
now += 5 * 60 * 1000 + 1
const restarted = api.startCriticalCanary({ ...target, owner })
res.emit('finish')
assert.equal(api.getCriticalCanaryStatus(target).state, 'testing')
assert.equal(api.tryCriticalCanaryRequest({ req: req(trial.canary_token), res: response(200), record: active[0], path: target.path }), false)
assert.notEqual(restarted.canary_token, trial.canary_token)
api.clearCriticalCanary(target)
assert.equal(api.getCriticalCanaryStatus(target), null)
console.log('PASS: Canary owner gate, bad token, redirect, two successes, expiration, in-flight restart, stale response, token rotation, and cleanup')
