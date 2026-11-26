import test from 'node:test'
import assert from 'node:assert/strict'
import { createResourceOptimizationEvidence } from '../services/resourceOptimizationEvidence.service.js'
import { buildResourceOptimizationAdvisor } from '../services/resourceOptimizationAdvisor.service.js'
import { getResourceOptimizationSnapshot } from '../services/resourceOptimizationSnapshot.service.js'

const now = 1_800_000_000_000
const req = (query = 'sort=latest', token = 'secret-a') => ({ method: 'GET', originalUrl: `/api/public/stories?${query}`, headers: { authorization: `Bearer ${token}`, 'accept-language': 'km' } })
const res = { statusCode: 200 }
const ctx = page => ({ page, supabase_calls: 2 })
const opts = (offset = 0) => ({ now: now + offset, responseBytes: 1000, closeReason: 'finish' })
const snapshot = monitor => monitor.snapshot({ now: now + 1000 })

test('same credential and query across pages is a review opportunity only', () => {
  const monitor = createResourceOptimizationEvidence()
  monitor.observeHttp(req(), res, ctx('WEB:/stories'), opts())
  monitor.observeHttp(req(), res, ctx('WEB:/discover'), opts(500))
  const evidence = snapshot(monitor)
  assert.equal(evidence.totals.repeated_signatures, 1)
  assert.equal(evidence.totals.cross_page_repeats, 1)
  assert.equal(evidence.totals.repeat_response_bytes, 1000)
  const advice = buildResourceOptimizationAdvisor(evidence)
  assert.equal(advice.findings[0].type, 'SHARED_DATA_OPPORTUNITY')
  assert.equal(advice.savings_confirmed, false)
  assert.equal(advice.auto_fix, false)
  assert.doesNotMatch(JSON.stringify({ evidence, advice }), /secret-a|sort=latest/)
})

test('different credentials, filters, language, cookie and range are not repeats', () => {
  const monitor = createResourceOptimizationEvidence()
  const requests = [req(), req('sort=latest', 'secret-b'), req('sort=popular'), { ...req(), headers: { ...req().headers, 'accept-language': 'en' } }, { ...req(), headers: { ...req().headers, cookie: 'private-cookie' } }, { ...req(), headers: { ...req().headers, range: 'items=0-9' } }]
  requests.forEach((request, index) => monitor.observeHttp(request, res, ctx('WEB:/stories'), opts(index)))
  assert.equal(snapshot(monitor).totals.repeated_signatures, 0)
})

test('does not count errors, aborted requests, mutations, unknown routes or unidentified guests', () => {
  const monitor = createResourceOptimizationEvidence()
  monitor.observeHttp(req(), { statusCode: 403 }, ctx('WEB:/stories'), opts())
  monitor.observeHttp(req(), res, ctx('WEB:/stories'), { ...opts(), closeReason: 'close' })
  monitor.observeHttp({ ...req(), method: 'POST' }, res, ctx('WEB:/stories'), opts())
  monitor.observeHttp({ ...req(), originalUrl: '/api/wallet' }, res, ctx('WEB:/stories'), opts())
  monitor.observeHttp({ ...req(), headers: {} }, res, ctx('WEB:/stories'), opts())
  assert.equal(snapshot(monitor).totals.observations, 0)
})

test('Supabase repeated reads scoped to same request and exact query and headers', () => {
  const monitor = createResourceOptimizationEvidence()
  const context = ctx('WEB:/stories')
  const read = { context, method: 'GET', url: 'https://example.supabase.co/rest/v1/stories?select=id&limit=5', headers: new Headers({ authorization: 'Bearer service-secret', range: '0-4' }), status: 200, now }
  monitor.observeSupabaseRead(read)
  monitor.observeSupabaseRead(read)
  monitor.observeSupabaseRead({ ...read, context: ctx('WEB:/stories') })
  monitor.observeSupabaseRead({ ...read, headers: new Headers({ range: '5-9' }) })
  monitor.observeSupabaseRead({ ...read, method: 'POST' })
  monitor.observeSupabaseRead({ ...read, status: 500 })
  const result = snapshot(monitor)
  assert.equal(result.totals.observations, 4)
  assert.equal(result.totals.repeated_signatures, 1)
  assert.doesNotMatch(JSON.stringify(result), /service-secret|select=id|example\.supabase/)
})

test('repeat time expires and detail windows are bounded', () => {
  const monitor = createResourceOptimizationEvidence()
  monitor.observeHttp(req(), res, ctx('WEB:/stories'), opts())
  monitor.observeHttp(req(), res, ctx('WEB:/stories'), opts(31_000))
  assert.equal(monitor.snapshot({ now: now + 31_001 }).totals.repeated_signatures, 0)
  for (let i = 1; i <= 9; i++) monitor.observeHttp(req(), res, ctx('WEB:/stories'), opts(i * 900_000))
  const result = monitor.snapshot({ now: now + 9 * 900_000 + 1 })
  assert.equal(result.windows_observed, 4)
  assert.equal(result.totals.observations, 4)
})

test('bounded recent keys and request-local database keys', () => {
  const monitor = createResourceOptimizationEvidence()
  for (let i = 0; i < 2600; i++) monitor.observeHttp(req(`page=${i}`), res, ctx('WEB:/stories'), opts())
  const context = ctx('WEB:/stories')
  for (let i = 0; i < 40; i++) monitor.observeSupabaseRead({ context, method: 'GET', url: `https://example.supabase.co/rest/v1/stories?offset=${i}`, status: 200, now })
  const result = snapshot(monitor)
  assert.equal(result.coverage.dropped_recent, 100)
  assert.equal(result.coverage.dropped_db_keys, 8)
})

test('standalone snapshot requires no database or network', () => {
  const result = getResourceOptimizationSnapshot({ now })
  assert.equal(result.evidence.totals.observations, 0)
  assert.equal(result.advisor.findings.length, 0)
})

test('guest visitor scopes and cache states are separate and secret-free', () => {
  const monitor = createResourceOptimizationEvidence()
  const guest = id => ({ ...req(), headers: { 'x-shadow-visitor-id': id } })
  monitor.observeHttp(guest('visitor-private-a'), res, ctx('WEB:/stories'), { ...opts(), cacheState: 'HIT' })
  monitor.observeHttp(guest('visitor-private-b'), res, ctx('WEB:/stories'), { ...opts(), cacheState: 'BYPASS' })
  monitor.observeHttp(guest('visitor-private-a'), res, ctx('WEB:/manga'), { ...opts(100), cacheState: 'STALE' })
  const result = snapshot(monitor)
  assert.equal(result.totals.repeated_signatures, 1)
  assert.equal(result.totals.cache_hits, 1)
  assert.equal(result.totals.cache_bypasses, 1)
  assert.equal(result.totals.cache_stale, 1)
  assert.doesNotMatch(JSON.stringify(result), /visitor-private/)
})
