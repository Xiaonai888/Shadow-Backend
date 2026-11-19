import test from 'node:test'
import assert from 'node:assert/strict'
import { readSharedMonitoringSnapshot } from '../services/sharedMonitoring/sharedMonitoringSnapshot.service.js'

const from = '2026-11-18T00:00:00.000Z'
const to = '2026-11-18T02:00:00.000Z'
const asOf = '2026-11-19T00:00:00.000Z'

function database(tables = {}, failures = []) {
  const visits = []
  return {
    visits,
    from(table) {
      visits.push(table)
      const checks = []
      return {
        select() { return this },
        gte(field, value) { checks.push((item) => String(item[field]) >= value); return this },
        lt(field, value) { checks.push((item) => String(item[field]) < value); return this },
        eq(field, value) { checks.push((item) => item[field] === value); return this },
        order() { return this },
        async range(start, end) {
          if (failures.includes(table)) return { data: null, error: { message: `Failed ${table}` } }
          return {
            data: (tables[table] || []).filter((item) => checks.every((check) => check(item))).slice(start, end + 1),
            error: null,
          }
        },
      }
    },
  }
}

function records() {
  return {
    render_bandwidth_hourly: [
      { service_id: 'srv-shared', hour_start: from, total_bytes: 300, breakdown_available: false },
    ],
    resource_cost_provider_observations: [
      { provider: 'supabase', observed_at: from, value: 12 },
    ],
    system_usage_snapshots: [
      {
        window_start: from,
        request_count: 2,
        bytes: 40,
        errors: 1,
        payload: {
          summary_rows: [{ kind: 'http_response', feature: 'test', dependency: 'CLIENT', count: 2, bytes: 40, errors: 1 }],
        },
      },
    ],
  }
}

test('shared snapshot reads each existing ledger once and never polls external providers', async () => {
  const client = database(records())
  const result = await readSharedMonitoringSnapshot({ from, to, asOf, serviceIds: ['srv-shared'] }, { client })
  assert.equal(result.query_status, 'ok')
  assert.equal(result.render.totals.total_bytes, 300)
  assert.equal(result.provider_observations.rows.length, 1)
  assert.equal(result.application.rows[0].errors, 1)
  assert.equal(result.render.billing_authoritative, false)
  assert.deepEqual(client.visits.sort(), [
    'render_bandwidth_hourly',
    'resource_cost_provider_observations',
    'system_usage_snapshots',
  ].sort())
})

test('provider read failure does not break Render or Error monitoring', async () => {
  const client = database(records(), ['resource_cost_provider_observations'])
  const result = await readSharedMonitoringSnapshot({ from, to, asOf, serviceIds: ['srv-shared'] }, { client })
  assert.equal(result.query_status, 'partial')
  assert.equal(result.provider_observations, null)
  assert.match(result.source_errors.provider_observations, /Failed/)
  assert.equal(result.render.totals.total_bytes, 300)
  assert.equal(result.application.rows[0].errors, 1)
})

test('Render failure does not become zero or break application monitoring', async () => {
  const client = database(records(), ['render_bandwidth_hourly'])
  const result = await readSharedMonitoringSnapshot({ from, to, asOf, serviceIds: ['srv-shared'] }, { client })
  assert.equal(result.query_status, 'partial')
  assert.equal(result.render, null)
  assert.equal(result.provider_observations.rows.length, 1)
  assert.equal(result.application.rows[0].count, 2)
})

test('Resource & Cost may skip application reads without affecting shared provider history', async () => {
  const client = database(records())
  const result = await readSharedMonitoringSnapshot({ from, to, asOf, includeApplication: false }, { client })
  assert.equal(result.query_status, 'ok')
  assert.equal(result.application, null)
  assert.equal(result.application_requested, false)
  assert.equal(result.source_reads, 2)
  assert.equal(client.visits.includes('system_usage_snapshots'), false)
})

test('missing provider records are unknown, not a fake invoice or zero bandwidth', async () => {
  const client = database()
  const result = await readSharedMonitoringSnapshot({ from, to, asOf, serviceIds: ['srv-shared'] }, { client })
  assert.equal(result.query_status, 'ok')
  assert.equal(result.render.totals, null)
  assert.equal(result.render.billing_authoritative, false)
  assert.deepEqual(result.provider_observations.rows, [])
})

test('complete data source outage is marked unavailable', async () => {
  const client = database({}, ['render_bandwidth_hourly', 'resource_cost_provider_observations'])
  const result = await readSharedMonitoringSnapshot({ from, to, asOf, includeApplication: false }, { client })
  assert.equal(result.query_status, 'unavailable')
  assert.equal(result.source_reads_succeeded, 0)
  assert.equal(result.render, null)
  assert.equal(result.provider_observations, null)
})

test('invalid or future-only ranges fail before querying the database', async () => {
  const client = database()
  await assert.rejects(readSharedMonitoringSnapshot({ from: to, to: from, asOf }, { client }), RangeError)
  await assert.rejects(readSharedMonitoringSnapshot({ from, to, asOf: '2026-11-17T00:00:00.000Z' }, { client }), RangeError)
  assert.deepEqual(client.visits, [])
})
