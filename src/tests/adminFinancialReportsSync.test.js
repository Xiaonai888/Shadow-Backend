import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createAdminFinancialReportsSyncService,
  normalizeFinancialReportPeriod,
} from '../services/adminFinancialReportsSync.service.js'

const now = new Date('2026-11-15T10:00:00.000Z')
const sample = (n) => Array.from({ length: n }, (_, index) => ({ transaction_key: `test:${index}` }))

function harness({ rows = [], writer, connector, configured = true } = {}) {
  const batches = []
  const service = createAdminFinancialReportsSyncService({
    clock: () => now,
    isConfigured: () => configured,
    loadRows: async ({ month }) => ({ rows, source_counts: { test: rows.length }, range: { month } }),
    writeRows: writer || (async (chunk) => {
      batches.push(chunk)
      return { ok: true, appended: chunk.length, updated: 0, skipped: 0 }
    }),
    connect: connector || (async () => ({ ok: true, spreadsheet_url: 'https://docs.google.com/spreadsheets/d/test', script_version: '1.0' })),
  })
  return { service, batches }
}

test('defaults to current Cambodia month and rejects future, malformed and wide ranges', () => {
  assert.deepEqual(normalizeFinancialReportPeriod({}, now), { month: '2026-11' })
  assert.deepEqual(normalizeFinancialReportPeriod({ month: '2026-10' }, now), { month: '2026-10' })
  assert.throws(() => normalizeFinancialReportPeriod({ month: '2026-12' }, now), /future/)
  assert.throws(() => normalizeFinancialReportPeriod({ month: '2026-13' }, now), /YYYY-MM/)
  assert.throws(() => normalizeFinancialReportPeriod({ month: '2026-11', from: now.toISOString() }, now), /OR/)
  assert.throws(() => normalizeFinancialReportPeriod({ from: '2026-10-01', to: '2026-11-01' }, now), /ISO/)
  assert.throws(() => normalizeFinancialReportPeriod({ from: '2026-01-01T00:00:00Z', to: '2026-11-01T00:00:00Z' }, now), /93 days/)
})

test('connect returns public response and never sends transaction rows', async () => {
  const { service, batches } = harness()
  const result = await service.connectSheet()
  assert.equal(result.ok, true)
  assert.equal(result.script_version, '1.0')
  assert.equal(result.connected_at, now.toISOString())
  assert.equal(service.status().connected_in_this_process, true)
  assert.equal(batches.length, 0)
})

test('sync sends 520 rows in bounded batches without a background timer', async () => {
  const { service, batches } = harness({ rows: sample(520) })
  const result = await service.syncPeriod({ month: '2026-11' })
  assert.equal(result.ok, true)
  assert.equal(result.processed, 520)
  assert.equal(result.appended, 520)
  assert.equal(result.batches, 3)
  assert.deepEqual(batches.map((chunk) => chunk.length), [250, 250, 20])
  const second = await service.syncPeriod({ month: '2026-11' })
  assert.equal(second.reused, true)
  assert.equal(batches.length, 3)
})

test('no rows means no requests to Google Sheets', async () => {
  const { service, batches } = harness()
  const result = await service.syncPeriod({ month: '2026-11' })
  assert.equal(result.rows_found, 0)
  assert.equal(batches.length, 0)
})

test('sync cannot run concurrently with another sync or connect', async () => {
  let release
  const held = new Promise((resolve) => { release = resolve })
  let entered
  const enteredPromise = new Promise((resolve) => { entered = resolve })
  const service = createAdminFinancialReportsSyncService({
    clock: () => now,
    isConfigured: () => true,
    loadRows: async () => { entered(); await held; return { rows: sample(1) } },
    writeRows: async () => ({ ok: true, appended: 1 }),
    connect: async () => ({ ok: true }),
  })
  const running = service.syncPeriod({ month: '2026-11' })
  await enteredPromise
  assert.equal(service.status().busy, true)
  await assert.rejects(service.syncPeriod({ month: '2026-11' }), /already processing/)
  await assert.rejects(service.connectSheet(), /already processing/)
  release()
  await running
  assert.equal(service.status().busy, false)
})

test('failed batch does not report success and allows retry', async () => {
  let attempt = 0
  const { service } = harness({ rows: sample(260), writer: async (rows) => {
    attempt += 1
    if (attempt === 2) throw new Error('Google unreachable')
    return { ok: true, appended: rows.length }
  } })
  await assert.rejects(service.syncPeriod({ month: '2026-11' }), (error) => {
    assert.equal(error.synced_rows, 250)
    return /unreachable/.test(error.message)
  })
  assert.equal(service.status().busy, false)
  assert.equal(service.status().last_sync, null)
  assert.equal(service.status().last_error.message, 'Google unreachable')
  const retry = await service.syncPeriod({ month: '2026-11' })
  assert.equal(retry.processed, 260)
})

test('oversized runs fail before making Google Sheets requests', async () => {
  const { service, batches } = harness({ rows: sample(3001) })
  await assert.rejects(service.syncPeriod({ month: '2026-11' }), /Too many transactions/)
  assert.equal(batches.length, 0)
})

test('unconfigured integration fails without touching data', async () => {
  const { service } = harness({ configured: false })
  assert.equal(service.status().configured, false)
  await assert.rejects(service.connectSheet(), /not configured/)
  await assert.rejects(service.syncPeriod({}), /not configured/)
})
