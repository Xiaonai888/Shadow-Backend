import test from 'node:test'
import assert from 'node:assert/strict'
import { createResourceCostDownload, resourceCostBreakdownRows } from '../services/resourceCostReportExport.service.js'
import { buildResourceCostSummary, resourceCostCalendarPeriod } from '../services/resourceCostSummary.service.js'
import { getResourceCostReport } from '../services/resourceCostReportData.service.js'

const from = '2026-11-12T17:00:00.000Z'
const to = '2026-11-13T17:00:00.000Z'
const asOf = '2026-11-14T06:00:00.000Z'

function fixture() {
  return buildResourceCostSummary({
    from,
    to,
    asOf,
    serviceIds: ['srv-test-1'],
    renderRows: [
      { service_id: 'srv-test-1', hour_start: from, total_bytes: 200, http_response_bytes: 80, service_initiated_bytes: 120, websocket_response_bytes: 0, private_link_bytes: 0, breakdown_available: true },
      { service_id: 'srv-test-1', hour_start: '2026-11-12T18:00:00Z', total_bytes: 100, breakdown_available: false },
    ],
    providerRows: [
      { provider: 'cloudflare_r2', metric: 'operations', scope: 'account', unit: 'requests', kind: 'cumulative', period_start: '2026-11-01T00:00:00Z', observed_hour: '2026-11-12T16:00:00Z', observed_at: '2026-11-12T16:35:00Z', value: 250, status: 'ok' },
      { provider: 'cloudflare_r2', metric: 'operations', scope: 'account', unit: 'requests', kind: 'cumulative', period_start: '2026-11-01T00:00:00Z', observed_hour: '2026-11-12T18:00:00Z', observed_at: '2026-11-12T18:35:00Z', value: 300, status: 'ok' },
      { provider: 'supabase', metric: 'database_size', scope: 'project', unit: 'bytes', kind: 'gauge', period_start: '2026-11-12T00:00:00Z', observed_hour: '2026-11-13T01:00:00Z', observed_at: '2026-11-13T01:30:00Z', value: 9000, status: 'ok' },
    ],
    uploadRows: [
      { hour_start: from, feature: 'novel', route: 'episode_image', upload_mode: 'proxy', attempts: 2, successes: 1, failures: 1, ingress_bytes: 700, egress_bytes: 200, object_bytes: 200 },
      { hour_start: from, feature: 'manga', route: 'signed_put', upload_mode: 'direct', attempts: 1, successes: 1, failures: 0, ingress_bytes: 0, egress_bytes: 0, object_bytes: 500 },
    ],
    applicationRows: [
      { hour_start: from, feature: 'reader', dependency: 'CLIENT', kind: 'http_response', count: 12, bytes: 60 },
    ],
  })
}

test('Cambodian day, Monday-based week, and month boundaries use +07', () => {
  assert.deepEqual(resourceCostCalendarPeriod('2026-11-13T23:00:00+07:00'), {
    from: '2026-11-12T17:00:00.000Z', to: '2026-11-13T17:00:00.000Z',
  })
  assert.deepEqual(resourceCostCalendarPeriod('2026-11-13T23:00:00+07:00', 'week'), {
    from: '2026-11-08T17:00:00.000Z', to: '2026-11-15T17:00:00.000Z',
  })
  assert.deepEqual(resourceCostCalendarPeriod('2026-11-13T23:00:00+07:00', 'month'), {
    from: '2026-10-31T17:00:00.000Z', to: '2026-11-30T17:00:00.000Z',
  })
})

test('Render provider totals remain separate from application and R2 counters', () => {
  const report = fixture()
  assert.equal(report.totals.render.total_bytes, 300)
  assert.equal(report.totals.render.http_response_bytes, 80)
  assert.equal(report.totals.render.service_initiated_bytes, 120)
  assert.equal(report.totals.render.missing_breakdown_service_hours, 1)
  assert.equal(report.days.length, 1)
  assert.equal(report.totals.invoiced_cost_usd, null)
  assert.equal(report.totals.upload_audit.ingress_bytes, 700)
  assert.equal(report.days[0].application_attribution[0].observed_bytes, 60)
  assert.equal(report.accuracy.independent_provider_bytes_must_not_be_summed, true)
})

test('Cumulative provider observations require an earlier comparable observation', () => {
  const report = fixture()
  const r2 = report.days[0].provider_metrics.find((item) => item.metric === 'operations')
  assert.equal(r2.value, 50)
  assert.equal(r2.aggregation, 'delta')
  const gauge = report.days[0].provider_metrics.find((item) => item.metric === 'database_size')
  assert.equal(gauge.value, 9000)
  assert.equal(gauge.aggregation, 'latest')
  const absentPrior = buildResourceCostSummary({
    from,
    to,
    asOf,
    providerRows: [
      { provider: 'cloudflare_r2', metric: 'ops', scope: 'account', unit: 'requests', kind: 'cumulative', period_start: '2026-11-01T00:00:00Z', observed_hour: from, observed_at: from, value: 9, status: 'ok' },
    ],
  })
  assert.equal(absentPrior.days[0].provider_metrics[0].incomplete_samples, 1)
  assert.equal(absentPrior.days[0].provider_metrics[0].value, null)
  assert.ok(absentPrior.days[0].warnings.includes('provider_metric_incomplete'))
})

test('Duplicate Render provider rows fail instead of inflating bandwidth', () => {
  const sample = { service_id: 'srv-test-1', hour_start: from, total_bytes: 200, breakdown_available: false }
  assert.throws(() => buildResourceCostSummary({ from, to, asOf, renderRows: [sample, sample] }), /Duplicate/)
})

test('Upload routes do not claim extra Render GB for R2 writes', () => {
  const report = fixture()
  const day = report.days[0]
  assert.equal(day.upload_audit.attempts, 3)
  assert.equal(day.upload_audit.by_route.length, 2)
  assert.equal(day.upload_audit.by_route.find((r) => r.upload_mode === 'direct').object_bytes, 500)
  const breakdown = resourceCostBreakdownRows(report)
  assert.equal(breakdown[0].render_bytes, 300)
  assert.equal(breakdown[0].upload_direct_attempts, 1)
  assert.equal(breakdown[0].upload_proxy_attempts, 2)
  assert.equal(breakdown[0].verified_invoice_usd, null)
})

test('Exports are real CSV and ZIP files, without inventing provider invoice amounts', () => {
  const report = fixture()
  const csvFile = createResourceCostDownload(report, 'daily-csv')
  assert.equal(csvFile.contentType, 'text/csv; charset=utf-8')
  assert.ok(csvFile.body.toString().includes('"render_bytes"'))
  assert.ok(csvFile.body.toString().includes('"300"'))
  assert.ok(csvFile.body.toString().includes('""'))
  const zipped = createResourceCostDownload(report, 'full-zip')
  assert.equal(zipped.contentType, 'application/zip')
  assert.equal(zipped.body.readUInt32LE(0), 0x04034b50)
  assert.ok(zipped.body.includes(Buffer.from('UploadRoutes.csv')))
  assert.ok(zipped.body.includes(Buffer.from('Evidence.json')))
  assert.throws(() => createResourceCostDownload(report, 'hidden'), /Unsupported/)
})

function mockDatabase(tables) {
  return {
    from(name) {
      const calls = []
      const query = {
        select() { return this },
        gte(field, value) { calls.push((row) => String(row[field]) >= value); return this },
        lt(field, value) { calls.push((row) => String(row[field]) < value); return this },
        eq(field, value) { calls.push((row) => row[field] === value); return this },
        order() { return this },
        range(start, end) { return Promise.resolve({ data: (tables[name] || []).filter((row) => calls.every((fn) => fn(row))).slice(start, end + 1), error: null }) },
      }
      return query
    },
  }
}

test('On-demand report reads existing tables; no periodic polling or new provider request', async () => {
  const report = await getResourceCostReport({ from, to, asOf, includeApplication: false, serviceIds: ['srv-test-1'] }, {
    client: mockDatabase({
      render_bandwidth_hourly: [{ service_id: 'srv-test-1', hour_start: from, total_bytes: 100, breakdown_available: false }],
      resource_cost_provider_observations: [],
      resource_cost_upload_hourly: [],
    }),
  })
  assert.equal(report.totals.render.total_bytes, 100)
  assert.equal(report.sources.application.status, 'not_requested')
  assert.equal(report.sources.render.rows, 1)
})

test('Exporter groups into weekly and monthly periods instead of summing provider types', () => {
  const report = fixture()
  assert.equal(resourceCostBreakdownRows(report, 'week')[0].render_bytes, 300)
  assert.equal(resourceCostBreakdownRows(report, 'month')[0].render_bytes, 300)
  assert.equal(resourceCostBreakdownRows(report, 'week')[0].period, '2026-11-09')
})


test('Provider interval reported after the end of a day belongs to its measured day', () => {
  const report = buildResourceCostSummary({
    from, to, asOf,
    providerRows: [
      { provider: 'supabase', metric: 'egress_bytes', scope: 'project', unit: 'bytes', kind: 'interval', period_start: '2026-11-13T16:00:00Z', period_end: '2026-11-13T17:00:00Z', observed_hour: '2026-11-13T17:00:00Z', observed_at: '2026-11-13T17:45:00Z', value: 1024, status: 'ok' },
    ],
  })
  const metric = report.days[0].provider_metrics.find((row) => row.metric === 'egress_bytes')
  assert.equal(metric.value, 1024)
  assert.equal(metric.aggregation, 'sum')
})

test('Source history remainder is labeled unclassified, not silently discarded', async () => {
  const report = await getResourceCostReport({ from, to, asOf, includeApplication: true }, {
    client: mockDatabase({
      render_bandwidth_hourly: [],
      resource_cost_provider_observations: [],
      resource_cost_upload_hourly: [],
      system_usage_snapshots: [{ window_start: from, window_end: '2026-11-12T17:15:00Z', request_count: 10, bytes: 100, payload: { top_rows: [{ feature: 'reader', dependency: 'CLIENT', kind: 'http_response', count: 3, bytes: 30 }] } }],
    }),
  })
  const unknown = report.days[0].application_attribution.find((row) => row.feature === 'unclassified')
  assert.ok(unknown)
  assert.equal(unknown.observed_bytes, 70)
  assert.equal(unknown.observed_events, 7)
  assert.equal(report.sources.application.status, 'partial_attribution')
})

test('A missing Render day has explicit missing coverage rather than authoritative zero', () => {
  const report = buildResourceCostSummary({ from, to, asOf, serviceIds: ['srv-test-1'] })
  assert.equal(report.days[0].render.coverage, 'missing')
  assert.ok(report.days[0].warnings.includes('render_missing'))
})
