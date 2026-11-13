import test from 'node:test'
import assert from 'node:assert/strict'
import { getResourceCostReport, summarizeMangaDirectJobs } from '../services/resourceCostReportData.service.js'

const from = '2026-11-12T17:00:00.000Z'
const to = '2026-11-13T17:00:00.000Z'
const asOf = '2026-11-14T06:00:00.000Z'

function job(id, at = '2026-11-13T07:42:00Z', size = 25000, intake = 'r2_direct') {
  return { id, job_type: 'manga_page_v2', created_at: at, payload: { intake, source_bytes: size }, status: 'queued' }
}

function mockDatabase(tables) {
  const requested = []
  const client = {
    from(name) {
      requested.push(name)
      const predicates = []
      const query = {
        select() { return this },
        gte(key, value) { predicates.push((row) => String(row[key]) >= value); return this },
        lt(key, value) { predicates.push((row) => String(row[key]) < value); return this },
        eq(key, value) { predicates.push((row) => row[key] === value); return this },
        order() { return this },
        range(start, end) {
          const rows = (tables[name] || []).filter((row) => predicates.every((match) => match(row)))
          return Promise.resolve({ data: rows.slice(start, end + 1), error: null })
        },
      }
      return query
    },
  }
  return { client, requested }
}

const a = '313fff71-fec5-489f-9da1-90ab37176bb3'
const b = 'ff99bdeb-b9b6-4dca-b365-030fda7893da'

test('Direct Manga job is counted once per durable job ID, not per retry', () => {
  const report = summarizeMangaDirectJobs([job(a), job(a), job(b)])
  assert.equal(report.verifiedJobs, 2)
  assert.equal(report.duplicates, 1)
  assert.equal(report.rows.length, 1)
  assert.equal(report.rows[0].attempts, 2)
  assert.equal(report.rows[0].object_bytes, 50000)
  assert.equal(report.rows[0].ingress_bytes, 50000)
  assert.equal(report.rows[0].egress_bytes, 0)
})

test('Only finalized direct R2 queued job with a verified ID is counted', () => {
  const report = summarizeMangaDirectJobs([
    job(a),
    job(b, undefined, 9000, 'backend_proxy'),
    { ...job(b), job_type: 'video_upload' },
    { ...job('', undefined, 10000), id: '' },
  ])
  assert.equal(report.verifiedJobs, 1)
  assert.equal(report.unverifiedJobs, 1)
  assert.equal(report.rows[0].successes, 1)
  assert.equal(report.rows[0].failures, 0)
})

test('Malformed source byte metadata is explicit partial coverage rather than invented bytes', () => {
  const report = summarizeMangaDirectJobs([job(a, undefined, 'missing')])
  assert.equal(report.verifiedJobs, 1)
  assert.equal(report.unknownSize, 1)
  assert.equal(report.rows[0].object_bytes, 0)
})

test('Manga acceptance remains counted if later processing fails', () => {
  const sample = { ...job(a), status: 'failed' }
  const report = summarizeMangaDirectJobs([sample])
  assert.equal(report.rows[0].successes, 1)
})

test('Report integrates queued direct R2 with existing proxy without adding Render bytes', async () => {
  const storedProxy = { hour_start: '2026-11-13T07:00:00.000Z', feature: 'manga_page_image', route: 'story_media.manga_raw', upload_mode: 'proxy', attempts: 1, successes: 1, failures: 0, ingress_bytes: 50000, egress_bytes: 10000, object_bytes: 10000 }
  const { client, requested } = mockDatabase({
    heavy_media_jobs: [job(a), job(b, undefined, 20000), job('fake', undefined, 7777, 'proxy')],
    resource_cost_upload_hourly: [storedProxy],
    render_bandwidth_hourly: [{ service_id: 'srv-test-1', hour_start: '2026-11-13T07:00:00Z', total_bytes: 1200, breakdown_available: false }],
  })
  const report = await getResourceCostReport({ from, to, asOf, serviceIds: ['srv-test-1'], includeApplication: false }, { client })
  assert.ok(requested.includes('heavy_media_jobs'))
  assert.equal(report.totals.render.total_bytes, 1200)
  assert.equal(report.totals.upload_audit.attempts, 3)
  assert.equal(report.totals.upload_audit.ingress_bytes, 95000)
  assert.equal(report.totals.upload_audit.egress_bytes, 10000)
  assert.equal(report.totals.upload_audit.object_bytes, 55000)
  assert.equal(report.sources.direct_manga.verified_queued_jobs, 2)
  assert.equal(report.accuracy.direct_manga_object_bytes_are_not_render_egress, true)
})

test('Existing direct ledger hour overrides derived job hour to avoid double counting', async () => {
  const storedDirect = { hour_start: '2026-11-13T07:00:00.000Z', feature: 'manga_page_image', route: 'story_media.manga_direct', upload_mode: 'direct', attempts: 1, successes: 1, failures: 0, ingress_bytes: 25000, egress_bytes: 0, object_bytes: 25000 }
  const { client } = mockDatabase({ heavy_media_jobs: [job(a)], resource_cost_upload_hourly: [storedDirect] })
  const report = await getResourceCostReport({ from, to, asOf, includeApplication: false }, { client })
  assert.equal(report.totals.upload_audit.attempts, 1)
  assert.equal(report.sources.direct_manga.existing_ledger_hour_groups, 1)
})

test('Unfinalized PUTs are not inferred and no direct R2 data is reported as exact provider bills', async () => {
  const { client } = mockDatabase({})
  const report = await getResourceCostReport({ from, to, asOf, includeApplication: false }, { client })
  assert.equal(report.totals.upload_audit.attempts, 0)
  assert.equal(report.totals.invoiced_cost_usd, null)
  assert.equal(report.accuracy.unfinalized_r2_signed_puts_are_not_observed, true)
})
