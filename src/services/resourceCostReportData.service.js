import { resourceCostRange, resourceCostTimestamp } from './resourceCostMath.service.js'
import { buildResourceCostSummary } from './resourceCostSummary.service.js'
import { readSharedMonitoringRender } from './sharedMonitoring/sharedMonitoringRender.service.js'
import { readSharedMonitoringProviders } from './sharedMonitoring/sharedMonitoringProviders.service.js'
import { readSharedMonitoringApplication } from './sharedMonitoring/sharedMonitoringApplication.service.js'

const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000
const PAGE_SIZE = 750
const MAX_ROWS_PER_SOURCE = 30_000
const MAX_DAYS = 31

async function clientOrDefault(client) {
  if (client) return client
  const { supabase } = await import('../config/supabase.js')
  return supabase
}

async function fetchAll(client, table, columns, timeField, from, to, options = {}) {
  const rows = []
  for (let offset = 0; offset < MAX_ROWS_PER_SOURCE; offset += PAGE_SIZE) {
    let query = client.from(table)
      .select(columns)
      .gte(timeField, from)
      .lt(timeField, to)
    if (options.granularity) query = query.eq('granularity', options.granularity)
    if (options.jobType) query = query.eq('job_type', options.jobType)
    query = query.order(timeField, { ascending: true })
    for (const field of options.tieBreakers || []) query = query.order(field, { ascending: true })
    query = query.range(offset, offset + PAGE_SIZE - 1)
    const { data, error } = await query
    if (error) throw new Error(`${table}: ${error.message || String(error)}`)
    if (!Array.isArray(data)) throw new Error(`${table}: invalid database response.`)
    rows.push(...data)
    if (data.length < PAGE_SIZE) return rows
  }
  throw new Error(`${table}: report row limit reached; reduce the date range. Nothing was silently omitted.`)
}

export function summarizeMangaDirectJobs(jobs = []) {
  const groups = new Map()
  const seen = new Set()
  let unknownSize = 0
  let unverifiedJobs = 0
  let duplicates = 0
  let verifiedJobs = 0
  for (const job of jobs) {
    if (job?.job_type !== 'manga_page_v2' || job?.payload?.intake !== 'r2_direct') continue
    const id = String(job.id || '')
    const created = Date.parse(job.created_at || '')
    if (!id || !Number.isFinite(created)) {
      unverifiedJobs += 1
      continue
    }
    if (seen.has(id)) {
      duplicates += 1
      continue
    }
    seen.add(id)
    const hour = new Date(Math.floor(created / HOUR_MS) * HOUR_MS).toISOString()
    const size = Number(job.payload?.source_bytes)
    const validSize = Number.isSafeInteger(size) && size > 0
    if (!validSize) unknownSize += 1
    const key = hour
    const group = groups.get(key) || {
      hour_start: hour,
      feature: 'manga_page_image',
      route: 'story_media.manga_direct',
      upload_mode: 'direct',
      attempts: 0,
      successes: 0,
      failures: 0,
      ingress_bytes: 0,
      egress_bytes: 0,
      object_bytes: 0,
    }
    group.attempts += 1
    group.successes += 1
    if (validSize) {
      group.ingress_bytes += size
      group.object_bytes += size
    }
    if (!Number.isSafeInteger(group.ingress_bytes)) throw new RangeError('Direct Manga bytes exceeded safe integer precision.')
    groups.set(key, group)
    verifiedJobs += 1
  }
  return { rows: [...groups.values()], verifiedJobs, unknownSize, unverifiedJobs, duplicates }
}

function detectedServices(value) {
  const ids = [
    process.env.RENDER_SERVICE_ID,
    process.env.SYSTEM_RENDER_SERVICE_ID,
    ...String(process.env.RENDER_SERVICE_IDS || '').split(/[\s,;]+/),
  ]
  if (Array.isArray(value)) ids.push(...value)
  return [...new Set(ids.map((item) => String(item || '').trim()).filter((item) => /^srv-[a-z0-9-]+$/i.test(item)))].sort()
}

export async function getResourceCostReport({
  from,
  to,
  asOf = new Date(),
  includeApplication = true,
  serviceIds = null,
} = {}, dependencies = {}) {
  const range = resourceCostRange(from, to, MAX_DAYS)
  const time = Math.min(resourceCostTimestamp(range.to), resourceCostTimestamp(asOf))
  const start = resourceCostTimestamp(range.from)
  if (time <= start) throw new RangeError('The reporting period must begin before the current time.')
  const end = new Date(time).toISOString()
  const database = await clientOrDefault(dependencies.client)
  const uploadFields = 'hour_start,feature,route,upload_mode,attempts,successes,failures,ingress_bytes,egress_bytes,object_bytes'
  const [sharedRender, sharedProviders, storedUploadRows, directMangaJobs, sharedApplication] = await Promise.all([
    readSharedMonitoringRender({
      from: range.from,
      to: end,
      asOf,
      serviceIds: detectedServices(serviceIds),
    }, { client: database }),
    readSharedMonitoringProviders({
      from: range.from,
      to: end,
      asOf,
    }, { client: database }),
    fetchAll(database, 'resource_cost_upload_hourly', uploadFields, 'hour_start', range.from, end, { tieBreakers: ['feature', 'route', 'upload_mode'] }),
    fetchAll(database, 'heavy_media_jobs', 'id,job_type,created_at,payload', 'created_at', range.from, end, { jobType: 'manga_page_v2', tieBreakers: ['id'] }),
    includeApplication
      ? readSharedMonitoringApplication({ from: range.from, to: end, asOf }, { client: database })
      : Promise.resolve(null),
  ])

  const renderRows = sharedRender.rows
  const providerRows = sharedProviders.rows
  const directManga = summarizeMangaDirectJobs(directMangaJobs)
  const existingDirectHours = new Set(storedUploadRows.filter((row) =>
    row.upload_mode === 'direct' && row.route === 'story_media.manga_direct'
  ).map((row) => row.hour_start))
  const includedDirectRows = directManga.rows.filter((row) => !existingDirectHours.has(row.hour_start))
  const uploadRows = [...storedUploadRows, ...includedDirectRows]

  const applicationRows = sharedApplication?.rows ?? []
  const applicationCoverage = {
    requested: Boolean(includeApplication),
    status: sharedApplication?.coverage?.status ?? 'not_requested',
    windows: sharedApplication?.coverage?.windows ?? 0,
    truncated_top_rows: true,
    source_types: sharedApplication?.coverage?.source_types ?? [],
    note: includeApplication
      ? start < resourceCostTimestamp(asOf) - 30 * DAY_MS
        ? 'Application-level detail older than 30 days can be unavailable after daily rollup retention.'
        : 'Top-route details are bounded. Unlisted application traffic and provider network overhead are not attributed.'
      : null,
  }

  const configuredRenderServiceIds = detectedServices(serviceIds)
  const summary = buildResourceCostSummary({
    from: range.from,
    to: end,
    asOf,
    serviceIds: configuredRenderServiceIds,
    renderRows,
    providerRows,
    uploadRows,
    applicationRows,
  })
  const validRenderRows = renderRows.filter((row) => {
    const hour = Date.parse(row?.hour_start || '')
    const bytes = row?.total_bytes
    return Boolean(String(row?.service_id || '').trim()) && Number.isFinite(hour) && hour % HOUR_MS === 0 &&
      bytes !== null && bytes !== undefined && bytes !== '' && Number.isSafeInteger(Number(bytes)) && Number(bytes) >= 0
  })
  const observedRenderServiceIds = [...new Set(validRenderRows.map(row => String(row.service_id).trim()))].sort()
  const renderIndex = new Map(validRenderRows.map(row => [`${String(row.service_id).trim()}|${Date.parse(row.hour_start)}`, row]))
  const matureUntil = Math.floor((resourceCostTimestamp(asOf) - 2 * HOUR_MS) / HOUR_MS) * HOUR_MS
  const renderHourGaps = summary.service_ids.map(service_id => {
    const missing_hour_utc = [], incomplete_breakdown_hour_utc = []
    let expected_hours = 0
    for (const day of summary.days) for (let h = Math.ceil(Date.parse(day.period_start) / HOUR_MS) * HOUR_MS; h < Math.min(Date.parse(day.period_end), matureUntil); h += HOUR_MS) {
      expected_hours++
      const row = renderIndex.get(`${service_id}|${h}`), hour = new Date(h).toISOString()
      if (!row) missing_hour_utc.push(hour)
      else if (row.breakdown_available !== true || ['http_response_bytes', 'service_initiated_bytes', 'websocket_response_bytes', 'private_link_bytes'].some(key => row[key] == null || !Number.isSafeInteger(Number(row[key])))) incomplete_breakdown_hour_utc.push(hour)
    }
    return { service_id, expected_hours, observed_hours: expected_hours - missing_hour_utc.length, missing_hour_utc, incomplete_breakdown_hour_utc }
  })
  const report = {
    ...summary,
    accuracy: {
      ...summary.accuracy,
      direct_manga_accepted_means_r2_intake_verified_and_processing_queued: true,
      direct_manga_object_bytes_are_not_render_egress: true,
      unfinalized_r2_signed_puts_are_not_observed: true,
    },
    sources: {
      render: {
        rows: renderRows.length,
        valid_hourly_rows: validRenderRows.length,
        invalid_hourly_rows: renderRows.length - validRenderRows.length,
        table: 'render_bandwidth_hourly',
        billing_authoritative: false,
        configured_service_ids: configuredRenderServiceIds,
        observed_service_ids: observedRenderServiceIds,
        configured_without_measurements: configuredRenderServiceIds.filter(id => !observedRenderServiceIds.includes(id)),
        observed_not_configured: observedRenderServiceIds.filter(id => !configuredRenderServiceIds.includes(id)),
        sync_service_limit_exceeded: configuredRenderServiceIds.length > 20,
        service_inventory_verified: false,
        service_hour_diagnostics: renderHourGaps,
      },
      provider: { rows: providerRows.filter((row) => resourceCostTimestamp(row.observed_at) >= start).length, table: 'resource_cost_provider_observations', include_late_interval_observations: true },
      upload: { rows: uploadRows.length, table: 'resource_cost_upload_hourly + heavy_media_jobs' },
      direct_manga: {
        table: 'heavy_media_jobs',
        job_type: 'manga_page_v2',
        intake: 'r2_direct',
        verified_queued_jobs: directManga.verifiedJobs,
        included_hour_groups: includedDirectRows.length,
        existing_ledger_hour_groups: directManga.rows.length - includedDirectRows.length,
        duplicate_job_rows_ignored: directManga.duplicates,
        jobs_with_unknown_size: directManga.unknownSize,
        jobs_with_invalid_identity_or_time: directManga.unverifiedJobs,
        coverage: directManga.unknownSize || directManga.unverifiedJobs ? 'partial' : 'verified_queued_only',
        note: 'Only verified R2 direct uploads with a queued Manga job are observed. This is not evidence that later processing finished. Unfinalized signed PUTs and billed R2 operations are not measured here.',
      },
      application: applicationCoverage,
    },
  }

  Object.defineProperty(report, 'renderHourlyRows', {
    value: validRenderRows,
    enumerable: false,
  })

  return report
}
