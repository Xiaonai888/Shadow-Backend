import test from 'node:test'
import assert from 'node:assert/strict'
import { getResourceCostHealth } from '../services/resourceCostHealth.service.js'

const now = '2026-11-13T10:00:00.000Z'

function database(tables = {}, failures = {}) {
  return {
    from(table) {
      let provider = null
      return {
        select() { return this },
        eq(field, value) { if (field === 'provider') provider = value; return this },
        order(field) { this.field = field; return this },
        limit() {
          if (failures[table]) return Promise.resolve({ data: null, error: { code: failures[table] } })
          const data = (tables[table] || []).filter((x) => !provider || x.provider === provider)
            .sort((a, b) => String(b[this.field]).localeCompare(String(a[this.field])))
          return Promise.resolve({ data: data.slice(0, 1), error: null })
        },
      }
    },
  }
}

const defaultProvider = {
  last_sync_at: '2026-11-13T09:00:00.000Z',
  render: { status: 'ok', checked_at: now },
  supabase: { status: 'ok', checked_at: now },
  cloudflare_r2: { status: 'ok', checked_at: now },
}
const uploads = {
  pending_attempts: 0, pending_groups: 0, failed_flushes: 0, overflow_events: 0,
  last_flush_at: null, last_error_at: null,
  durability: 'memory_until_successful_batch_commit',
}
const tables = {
  render_bandwidth_hourly: [{ hour_start: '2026-11-13T08:00:00.000Z' }],
  resource_cost_provider_observations: [
    { provider: 'supabase', observed_at: '2026-11-13T09:00:00.000Z' },
    { provider: 'cloudflare_r2', observed_at: '2026-11-13T09:30:00.000Z' },
  ],
  resource_cost_upload_hourly: [{ hour_start: '2026-11-12T04:00:00.000Z' }],
  system_usage_snapshots: [{ window_end: '2026-11-13T09:45:00.000Z' }],
}
async function health(overrides = {}) {
  return getResourceCostHealth({ now, providerState: defaultProvider, uploadHealth: uploads, client: database(tables), ...overrides })
}

test('Recent provider observations and idle upload sources are distinguished', async () => {
  const result = await health()
  assert.equal(result.sources.render.status, 'recent')
  assert.equal(result.sources.supabase.status, 'recent')
  assert.equal(result.sources.cloudflare_r2.status, 'recent')
  assert.equal(result.sources.upload_audit.status, 'recorded')
  assert.equal(result.sources.application.status, 'recorded')
  assert.equal(result.database_readable, true)
  assert.equal(result.verified_complete, false)
  assert.deepEqual(result.warnings, [])
})

test('Empty event-driven tables do not become false outages', async () => {
  const result = await health({ client: database({ ...tables, resource_cost_upload_hourly: [], system_usage_snapshots: [] }) })
  assert.equal(result.sources.upload_audit.status, 'no_recorded_events')
  assert.equal(result.sources.application.status, 'no_recorded_events')
  assert.equal(result.warnings.length, 0)
})

test('Missing provider observations are not represented as zero usage', async () => {
  const result = await health({ client: database({ ...tables, resource_cost_provider_observations: [] }) })
  assert.equal(result.sources.supabase.status, 'no_measurements')
  assert.equal(result.sources.supabase.latest_at, null)
  assert.ok(result.warnings.includes('supabase_measurements_missing'))
})

test('Provider staleness triggers an explicit warning', async () => {
  const result = await health({ client: database({ ...tables, render_bandwidth_hourly: [{ hour_start: '2026-11-12T00:00:00.000Z' }] }) })
  assert.equal(result.sources.render.status, 'delayed')
  assert.ok(result.warnings.includes('render_measurements_delayed'))
})

test('Database schema failures are readable and do not leak errors', async () => {
  const result = await health({ client: database(tables, { resource_cost_provider_observations: '42P01' }) })
  assert.equal(result.sources.supabase.status, 'table_missing')
  assert.equal(result.sources.cloudflare_r2.status, 'table_missing')
  assert.equal(result.database_readable, false)
  assert.ok(result.warnings.includes('database_setup_incomplete'))
})

test('Unexpected DB errors are flagged without claiming no measurements', async () => {
  const result = await health({ client: database(tables, { render_bandwidth_hourly: '503' }) })
  assert.equal(result.sources.render.status, 'query_failed')
  assert.equal(result.database_readable, false)
  assert.ok(result.warnings.includes('database_source_unavailable'))
})

test('Provider unavailable and pending uploads are visible separately', async () => {
  const result = await health({
    providerState: { ...defaultProvider, supabase: { status: 'not_configured' }, cloudflare_r2: { status: 'error' } },
    uploadHealth: { ...uploads, pending_attempts: 3, pending_groups: 2, failed_flushes: 1, overflow_events: 4 },
  })
  assert.ok(result.warnings.includes('supabase_not_configured'))
  assert.ok(result.warnings.includes('cloudflare_r2_provider_sync_error'))
  assert.ok(result.warnings.includes('upload_audit_save_failures'))
  assert.ok(result.warnings.includes('upload_audit_not_yet_persisted'))
  assert.ok(result.warnings.includes('upload_audit_overflow'))
  assert.equal(result.upload_queue.pending_attempts, 3)
})

test('Rejects invalid time instead of inventing a status', async () => {
  await assert.rejects(health({ now: 'not-a-date' }), TypeError)
})
