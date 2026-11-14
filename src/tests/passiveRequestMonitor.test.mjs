import test from 'node:test'
import assert from 'node:assert/strict'
import { observePassiveRequest, getPassiveRequestSnapshot } from '../services/passiveRequestMonitor.service.js'

const now = Math.floor(Date.now() / 60_000) * 60_000 + 10_000

function request(method, route, headers = {}, ip = '10.0.0.20') {
  return {
    req: { method, headers, ip },
    res: { statusCode: 200 },
    context: {
      page: 'WEB:/diagnostics-test',
      route,
      supabase_calls: 2,
      external_calls: 0,
    },
  }
}

test('collects existing requests without a network action', () => {
  const input = request('GET', 'GET /api/test-passive-collector', { 'x-shadow-visibility': 'hidden' })
  observePassiveRequest(input.req, input.res, input.context, { now, responseBytes: 1536 })
  const report = getPassiveRequestSnapshot({ from: now - 1000, to: now + 60000, now })
  const row = report.rows.find((item) => item.route === input.context.route)
  assert.ok(row)
  assert.equal(row.requests, 1)
  assert.equal(row.client_reported_hidden_requests, 1)
  assert.equal(row.response_bytes, 1536)
  assert.equal(row.supabase_calls, 2)
  assert.equal(row.classification, 'REVIEW')
  assert.ok(row.signals.includes('CLIENT_REPORTED_HIDDEN_ACTIVITY'))
  assert.equal(report.mode, 'passive_existing_http_requests_only')
})

test('flags repeat GET observations from a matching apparent client', () => {
  const input = request('GET', 'GET /api/test-passive-repeats', {
    authorization: 'Bearer test-token-for-monitor-only',
    'x-shadow-visibility': 'visible',
  })
  for (let i = 0; i < 14; i += 1) {
    observePassiveRequest(input.req, input.res, input.context, { now: now + i * 1000 })
  }
  const report = getPassiveRequestSnapshot({ from: now - 1000, to: now + 60000, now: now + 20000 })
  const row = report.rows.find((item) => item.route === input.context.route)
  assert.ok(row)
  assert.equal(row.requests, 14)
  assert.equal(row.rapid_repeat_requests, 3)
  assert.equal(row.rapid_repeat_authenticated_requests, 3)
  assert.ok(row.signals.includes('RAPID_REPEAT_SUSPECTED'))
})

test('does not count existing System Control traffic as a monitoring target', () => {
  const input = request('GET', 'GET /api/admin/system-control/snapshot')
  observePassiveRequest(input.req, input.res, input.context, { now })
  const report = getPassiveRequestSnapshot({ from: now - 1000, to: now + 60000, now })
  assert.equal(report.rows.some((row) => row.route === input.context.route), false)
})

test('does not claim unknown visibility is a hidden tab', () => {
  const input = request('GET', 'GET /api/test-passive-no-visibility', {}, '10.0.0.22')
  observePassiveRequest(input.req, input.res, input.context, { now })
  const report = getPassiveRequestSnapshot({ from: now - 1000, to: now + 60000, now })
  const row = report.rows.find((item) => item.route === input.context.route)
  assert.equal(row.unknown_visibility_requests, 1)
  assert.equal(row.client_reported_hidden_requests, 0)
  assert.equal(row.classification, 'OBSERVED')
})
