import assert from 'node:assert/strict'
import test from 'node:test'
import { summarizeStoredErrorEvidence } from '../services/systemUsageHistoricalErrorEvidence.service.js'

const start = '2026-11-21T10:00:00.000Z'
const end = '2026-11-21T10:15:00.000Z'
const entry = {
  window_start: start,
  window_end: end,
  route: 'GET /api/public/stories/:id',
  http_status: 503,
  response_code: 'UPSTREAM_ERROR',
  root_cause_code: 'SUPABASE_HTTP_503',
  diagnostic_stage: 'database',
  provider: 'SUPABASE',
  count: 3,
  last_seen_at: '2026-11-21T10:14:00.000Z',
}

const range = {
  fromMs: Date.parse(start),
  toMs: Date.parse(end),
}

test('uses stored snapshots across a 24-hour report instead of only live memory', () => {
  const result = summarizeStoredErrorEvidence([{ payload: { error_evidence: [entry] } }], [], range)
  assert.equal(result.rows.length, 1)
  assert.equal(result.rows[0].count, 3)
  assert.equal(result.rows[0].root_cause_code, 'SUPABASE_HTTP_503')
  assert.equal(result.coverage.stored_windows_with_error_field, 1)
})

test('does not double count a bucket repeated by stored and live evidence', () => {
  const result = summarizeStoredErrorEvidence(
    [{ payload: { error_evidence: [entry] } }],
    [{ ...entry, count: 4 }],
    range
  )
  assert.equal(result.rows.length, 1)
  assert.equal(result.rows[0].count, 4)
  assert.equal(result.rows[0].evidence_source, 'stored_15m')
})

test('reports coverage limitations and excludes unrelated windows', () => {
  const outside = { ...entry, window_start: '2026-11-20T09:00:00.000Z', window_end: '2026-11-20T09:15:00.000Z' }
  const result = summarizeStoredErrorEvidence([
    { payload: {} },
    { payload: { error_evidence: [outside] } },
  ], [], range)
  assert.equal(result.rows.length, 0)
  assert.equal(result.coverage.stored_windows_without_error_field, 1)
})

test('removes arbitrary error-message text from the report rows', () => {
  const result = summarizeStoredErrorEvidence([{ payload: { error_evidence: [
    { ...entry, sample_error: 'sensitive user input', sample_request_id: 'trace-id' },
  ] } }], [], range)
  assert.ok(!Object.hasOwn(result.rows[0], 'sample_error'))
  assert.ok(!Object.hasOwn(result.rows[0], 'sample_request_id'))
})
