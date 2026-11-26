import test from 'node:test'
import assert from 'node:assert/strict'
import { buildResourceOptimizationHistory } from '../services/resourceOptimizationHistory.service.js'

const W = 900000
const start = Date.parse('2026-11-26T00:00:00.000Z')
const iso = value => new Date(value).toISOString()
const row = { kind: 'HTTP', route: 'GET /api/public/stories', page: 'WEB:/stories', observations: 4, repeated_signatures: 2, cross_page_repeats: 1, repeat_response_bytes: 1200 }
function window(at = start, overrides = {}) {
  return { window_start: iso(at), window_end: iso(at + W), payload: { resource_optimization: { version: 1, window_ms: W, from: iso(at), to: iso(at + W), windows_observed: 1, totals: row, total_rows: 1, rows: [row], ...overrides } } }
}

test('aggregates complete distinct windows and builds findings', () => {
  const { evidence, advisor } = buildResourceOptimizationHistory([window(), window(start + W), window()], start, start + 2 * W)
  assert.equal(evidence.totals.repeat_response_bytes, 2400)
  assert.equal(evidence.rows[0].observations, 8)
  assert.equal(evidence.coverage.duplicate_windows_ignored, 1)
  assert.equal(evidence.status, 'observed')
  assert.equal(advisor.findings[0].type, 'SHARED_DATA_OPPORTUNITY')
})

test('does not claim zero for unavailable historical evidence', () => {
  const { evidence } = buildResourceOptimizationHistory([window(start, { windows_observed: 0 })], start, start + W)
  assert.equal(evidence.status, 'unavailable')
  assert.equal(evidence.totals, null)
})

test('does not count partial boundary buckets', () => {
  const { evidence } = buildResourceOptimizationHistory([window(), window(start + W)], start + 1, start + 2 * W)
  assert.equal(evidence.stored_windows, 1)
  assert.equal(evidence.coverage.partial_boundary_windows_excluded, true)
})

test('preserves total counts separately from capped detail', () => {
  const { evidence } = buildResourceOptimizationHistory([window(start, { detail_capped: true, totals: { observations: 100 } })], start, start + 2 * W)
  assert.equal(evidence.status, 'partial')
  assert.equal(evidence.totals.observations, 100)
  assert.equal(evidence.detail_capped, true)
})

test('never exports raw unknown routes or extra row fields', () => {
  const { evidence } = buildResourceOptimizationHistory([window(start, { rows: [{ ...row, route: 'GET /secret?token=example' }, { ...row, token: 'example', page: 'WEB:/private-name' }] })], start, start + W)
  assert.equal(evidence.rows.length, 1)
  assert.equal(evidence.rows[0].page, 'WEB:/:other')
  assert.equal(evidence.coverage.rejected_detail_rows, 1)
  assert.equal(JSON.stringify(evidence).includes('example'), false)
})

test('rejects invalid ranges', () => {
  assert.throws(() => buildResourceOptimizationHistory([], start, start), RangeError)
})
