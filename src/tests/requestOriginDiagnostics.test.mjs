import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import {
  recordRequestOriginReport,
  getRequestOriginSnapshot,
} from '../services/requestOriginDiagnostics.service.js'

function report(overrides = {}, at = Date.now()) {
  return {
    version: 1,
    report_id: randomUUID(),
    session_id: randomUUID(),
    sampled: true,
    sample_rate: 0.1,
    build: 'test-build',
    events: [{
      page: 'DISCOVER',
      route: '/api/public/content-versions',
      method: 'GET',
      source_file: 'src/providers/SmartRefreshProvider.jsx',
      trigger: 'focus',
      observed_count: 4,
      window_ms: 10_000,
      hidden_count: 0,
      error_count: 0,
      observed_at: new Date(at).toISOString(),
    }],
    ...overrides,
  }
}

test('accepts bounded diagnostics and exposes aggregate only', () => {
  const now = Date.now()
  const input = report({}, now)
  assert.equal(recordRequestOriginReport(input, now), true)
  const result = getRequestOriginSnapshot({ now, minutes: 2 })
  const row = result.rows.find((item) => item.route === '/api/public/content-versions')
  assert.ok(row)
  assert.equal(row.source_file, 'src/providers/SmartRefreshProvider.jsx')
  assert.ok(row.reports >= 1)
  assert.equal(result.mode, 'sampled_client_anomaly_aggregates')
  assert.equal(JSON.stringify(result).includes(input.session_id), false)
  assert.equal(JSON.stringify(result).includes(input.report_id), false)
})

test('replayed report is not counted again', () => {
  const now = Date.now()
  const input = report({}, now)
  const before = getRequestOriginSnapshot({ now }).rows
    .reduce((sum, row) => sum + row.reports, 0)
  assert.equal(recordRequestOriginReport(input, now), true)
  assert.equal(recordRequestOriginReport(input, now + 100), true)
  const after = getRequestOriginSnapshot({ now: now + 100 }).rows
    .reduce((sum, row) => sum + row.reports, 0)
  assert.equal(after, before + 1)
})

test('rejects malformed and stale claims', () => {
  const now = Date.now()
  assert.equal(recordRequestOriginReport(report({ sample_rate: 1 }, now), now), false)
  assert.equal(recordRequestOriginReport(report({ events: [] }, now), now), false)
  assert.equal(recordRequestOriginReport(report({ events: [{
    page: 'DISCOVER', route: '/api/public/content-versions', method: 'GET',
    source_file: 'src/providers/SmartRefreshProvider.jsx', trigger: 'timer',
    observed_count: 4, window_ms: 10_000, hidden_count: 0, error_count: 0,
    observed_at: new Date(now - 60 * 60_000).toISOString(),
  }] }, now), now), false)
})

test('redacts unknown route segments instead of retaining identifiers', () => {
  const now = Date.now()
  const input = report({ events: [{
    page: 'READER', route: '/api/public/stories/secret-reader-id/episodes',
    method: 'GET', source_file: 'UNATTRIBUTED', trigger: 'unknown',
    observed_count: 12, window_ms: 60_000, hidden_count: 1,
    error_count: 2, observed_at: new Date(now).toISOString(),
  }] }, now)
  assert.equal(recordRequestOriginReport(input, now), true)
  const output = JSON.stringify(getRequestOriginSnapshot({ now }))
  assert.equal(output.includes('secret-reader-id'), false)
  assert.ok(output.includes('/api/public/stories/:id/episodes'))
})
