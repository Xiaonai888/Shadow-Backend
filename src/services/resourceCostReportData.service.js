import { resourceCostRange, resourceCostTimestamp } from './resourceCostMath.service.js'
import { buildResourceCostSummary } from './resourceCostSummary.service.js'

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

function applicationFromWindow(row, timeField) {
  const start = row[timeField]
  const top = Array.isArray(row?.payload?.top_rows) ? row.payload.top_rows : []
  const result = top.map((item) => ({
    hour_start: start,
    feature: String(item.feature || 'unknown'),
    kind: String(item.kind || 'unknown'),
    dependency: String(item.dependency || 'UNKNOWN'),
    count: Number(item.count) || 0,
    bytes: Number(item.bytes) || 0,
  }))
  const countedBytes = result.reduce((sum, row) => sum + (Number(row.bytes) || 0), 0)
  const countedEvents = result.reduce((sum, row) => sum + (Number(row.count) || 0), 0)
  const missingBytes = Math.max(0, (Number(row.bytes) || 0) - countedBytes)
  const missingEvents = Math.max(0, (Number(row.request_count) || 0) - countedEvents)
  if (missingBytes || missingEvents) result.push({
    hour_start: start,
    feature: 'unclassified',
    kind: 'unclassified',
    dependency: 'UNKNOWN',
    count: missingEvents,
    bytes: missingBytes,
  })
  return result
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
  const obsStart = new Date(start - 27 * HOUR_MS).toISOString()
  const obsEnd = new Date(Math.min(resourceCostTimestamp(asOf), time + 48 * HOUR_MS)).toISOString()
  const renderFields = 'service_id,hour_start,total_bytes,http_response_bytes,service_initiated_bytes,websocket_response_bytes,private_link_bytes,breakdown_available'
  const providerFields = 'provider,metric,scope,observed_hour,observed_at,period_start,period_end,kind,unit,value,status'
  const uploadFields = 'hour_start,feature,route,upload_mode,attempts,successes,failures,ingress_bytes,egress_bytes,object_bytes'
  const [renderRows, providerRows, uploadRows] = await Promise.all([
    fetchAll(database, 'render_bandwidth_hourly', renderFields, 'hour_start', range.from, end, { tieBreakers: ['service_id'] }),
    fetchAll(database, 'resource_cost_provider_observations', providerFields, 'observed_at', obsStart, obsEnd, { tieBreakers: ['provider', 'metric', 'scope'] }),
    fetchAll(database, 'resource_cost_upload_hourly', uploadFields, 'hour_start', range.from, end, { tieBreakers: ['feature', 'route', 'upload_mode'] }),
  ])

  const applicationRows = []
  const applicationCoverage = { requested: Boolean(includeApplication), status: 'not_requested', windows: 0, truncated_top_rows: true, source_types: [], note: null }
  if (includeApplication) {
    const cutoff = Math.floor((resourceCostTimestamp(asOf) - 7 * DAY_MS) / HOUR_MS) * HOUR_MS
    const archiveEnd = new Date(Math.min(cutoff, time)).toISOString()
    const liveStart = new Date(Math.max(start, cutoff)).toISOString()
    const sourceTypes = new Set()
    if (start < cutoff) {
      const archived = await fetchAll(database, 'system_usage_rollups', 'granularity,bucket_start,bucket_end,request_count,bytes,payload', 'bucket_start', range.from, archiveEnd, { granularity: 'hour' })
      for (const window of archived) {
        applicationRows.push(...applicationFromWindow(window, 'bucket_start'))
        sourceTypes.add('hourly_rollup')
      }
      applicationCoverage.windows += archived.length
    }
    if (time > cutoff) {
      const snapshots = await fetchAll(database, 'system_usage_snapshots', 'window_start,window_end,request_count,bytes,payload', 'window_start', liveStart, end)
      for (const window of snapshots) {
        applicationRows.push(...applicationFromWindow(window, 'window_start'))
        sourceTypes.add('15_minute_snapshots')
      }
      applicationCoverage.windows += snapshots.length
    }
    applicationCoverage.status = applicationCoverage.windows ? 'partial_attribution' : 'missing'
    applicationCoverage.source_types = [...sourceTypes]
    applicationCoverage.note = start < resourceCostTimestamp(asOf) - 30 * DAY_MS
      ? 'Application-level detail older than 30 days can be unavailable after daily rollup retention.'
      : 'Top-route details are bounded. Unlisted application traffic and provider network overhead are not attributed.'
  }

  const summary = buildResourceCostSummary({
    from: range.from,
    to: end,
    asOf,
    serviceIds: detectedServices(serviceIds),
    renderRows,
    providerRows,
    uploadRows,
    applicationRows,
  })
  return {
    ...summary,
    sources: {
      render: { rows: renderRows.length, table: 'render_bandwidth_hourly', billing_authoritative: false },
      provider: { rows: providerRows.filter((row) => resourceCostTimestamp(row.observed_at) >= start).length, table: 'resource_cost_provider_observations', include_late_interval_observations: true },
      upload: { rows: uploadRows.length, table: 'resource_cost_upload_hourly' },
      application: applicationCoverage,
    },
  }
}
