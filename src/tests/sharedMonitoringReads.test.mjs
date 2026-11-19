import test from 'node:test'
import assert from 'node:assert/strict'
import { readSharedMonitoringRows } from '../services/sharedMonitoring/sharedMonitoringRows.service.js'
import { readSharedMonitoringRender } from '../services/sharedMonitoring/sharedMonitoringRender.service.js'
import { readSharedMonitoringProviders } from '../services/sharedMonitoring/sharedMonitoringProviders.service.js'
import { readSharedMonitoringApplication } from '../services/sharedMonitoring/sharedMonitoringApplication.service.js'

const from = '2026-11-18T00:00:00.000Z'
const to = '2026-11-18T02:00:00.000Z'
const asOf = '2026-11-19T00:00:00.000Z'

function fakeDatabase(tables) {
  const visited = []
  return {
    visited,
    from(table) {
      visited.push(table)
      const predicates = []
      const query = {
        select() { return this },
        gte(field, value) { predicates.push((row) => String(row[field]) >= value); return this },
        lt(field, value) { predicates.push((row) => String(row[field]) < value); return this },
        eq(field, value) { predicates.push((row) => row[field] === value); return this },
        order() { return this },
        range(start, end) {
          return Promise.resolve({ data: (tables[table] || []).filter((row) => predicates.every((check) => check(row))).slice(start, end + 1), error: null })
        },
      }
      return query
    },
  }
}

test('shared render reads the official ledger without a second provider poller', async () => {
  const client = fakeDatabase({
    render_bandwidth_hourly: [
      { service_id: 'srv-check', hour_start: from, total_bytes: 200, http_response_bytes: 80, service_initiated_bytes: 120, websocket_response_bytes: 0, private_link_bytes: 0, breakdown_available: true },
      { service_id: 'srv-check', hour_start: '2026-11-18T01:00:00.000Z', total_bytes: 300, breakdown_available: false },
    ],
  })
  const result = await readSharedMonitoringRender({ from, to, asOf, serviceIds: ['srv-check'] }, { client })
  assert.equal(result.totals.total_bytes, 500)
  assert.equal(result.totals.observed_service_hours, 2)
  assert.equal(result.totals.missing_breakdown_service_hours, 1)
  assert.equal(result.billing_authoritative, false)
  assert.deepEqual(client.visited, ['render_bandwidth_hourly'])
})

test('shared provider records include a prior observation without pretending it is an invoice', async () => {
  const client = fakeDatabase({
    resource_cost_provider_observations: [
      { provider: 'cloudflare_r2', observed_at: '2026-11-17T10:00:00.000Z', value: 10 },
      { provider: 'supabase', observed_at: from, value: 20 },
    ],
  })
  const data = await readSharedMonitoringProviders({ from, to, asOf }, { client })
  assert.equal(data.rows.length, 2)
  assert.equal(data.observation_range.from, '2026-11-16T21:00:00.000Z')
  assert.equal(data.invoice_cost_verified, false)
})

test('application rows stay separate from official Render outbound bytes', async () => {
  const client = fakeDatabase({
    system_usage_snapshots: [{
      window_start: from,
      request_count: 2,
      bytes: 20,
      errors: 1,
      payload: { summary_rows: [{ kind: 'http_response', feature: 'test', dependency: 'CLIENT', count: 2, bytes: 20, errors: 1 }] },
    }],
  })
  const data = await readSharedMonitoringApplication({ from, to, asOf }, { client })
  assert.equal(data.rows.length, 1)
  assert.equal(data.rows[0].errors, 1)
  assert.equal(data.coverage.status, 'partial_attribution')
  assert.deepEqual(client.visited, ['system_usage_snapshots'])
})

test('paging returns complete rows and rejects invalid ranges', async () => {
  const items = Array.from({ length: 751 }, (_, i) => ({ time: from, id: String(i) }))
  const client = fakeDatabase({ entries: items })
  const rows = await readSharedMonitoringRows({ table: 'entries', columns: 'id,time', timeField: 'time', from, to }, client)
  assert.equal(rows.length, 751)
  assert.deepEqual(client.visited, ['entries', 'entries'])
  await assert.rejects(readSharedMonitoringRows({ table: 'entries', columns: '*', timeField: 'time', from: to, to: from }, client), RangeError)
})

test('same Render hour is never silently counted twice', async () => {
  const row = { service_id: 'srv-check', hour_start: from, total_bytes: 200, breakdown_available: false }
  const client = fakeDatabase({ render_bandwidth_hourly: [row, row] })
  await assert.rejects(readSharedMonitoringRender({ from, to, asOf, serviceIds: ['srv-check'] }, { client }), /Duplicate/)
})

test('missing provider history stays unknown instead of reporting zero cost', async () => {
  const client = fakeDatabase({ render_bandwidth_hourly: [] })
  const result = await readSharedMonitoringRender({ from, to, asOf, serviceIds: ['srv-check'] }, { client })
  assert.equal(result.totals, null)
  assert.equal(result.days[0].render, null)
  assert.equal(result.billing_authoritative, false)
})

test('a thirty-one-day reporting window allows historical provider lookback', async () => {
  const client = fakeDatabase({ resource_cost_provider_observations: [] })
  const start = '2026-10-18T00:00:00.000Z'
  const end = '2026-11-18T00:00:00.000Z'
  const data = await readSharedMonitoringProviders({ from: start, to: end, asOf }, { client })
  assert.equal(data.rows.length, 0)
  assert.equal(data.observation_range.from, '2026-10-16T21:00:00.000Z')
})
