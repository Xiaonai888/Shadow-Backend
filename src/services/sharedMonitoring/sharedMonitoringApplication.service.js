import { resourceCostRange, resourceCostTimestamp } from '../resourceCostMath.service.js'
import { resourceCostAttributionReportRows } from '../resourceCostAttributionReport.service.js'
import { readSharedMonitoringRows } from './sharedMonitoringRows.service.js'

const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000

export async function readSharedMonitoringApplication({
  from,
  to,
  asOf = new Date(),
} = {}, { client = null } = {}) {
  const requested = resourceCostRange(from, to, 31)
  const start = resourceCostTimestamp(requested.from)
  const end = Math.min(resourceCostTimestamp(requested.to), resourceCostTimestamp(asOf))
  if (end <= start) throw new RangeError('Application monitoring period must precede the measurement time.')

  const cutoff = Math.floor((resourceCostTimestamp(asOf) - 7 * DAY_MS) / HOUR_MS) * HOUR_MS
  const rows = []
  const sourceTypes = []
  let windows = 0

  if (start < cutoff) {
    const archiveEnd = Math.min(cutoff, end)
    if (archiveEnd > start) {
      const archived = await readSharedMonitoringRows({
        table: 'system_usage_rollups',
        columns: 'granularity,bucket_start,bucket_end,request_count,bytes,payload',
        timeField: 'bucket_start',
        from: requested.from,
        to: new Date(archiveEnd).toISOString(),
        filters: { granularity: 'hour' },
      }, client)
      for (const item of archived) rows.push(...resourceCostAttributionReportRows(item, 'bucket_start'))
      windows += archived.length
      sourceTypes.push('hourly_rollup')
    }
  }

  const liveStart = Math.max(start, cutoff)
  if (end > liveStart) {
    const snapshots = await readSharedMonitoringRows({
      table: 'system_usage_snapshots',
      columns: 'window_start,window_end,request_count,bytes,payload',
      timeField: 'window_start',
      from: new Date(liveStart).toISOString(),
      to: new Date(end).toISOString(),
    }, client)
    for (const item of snapshots) rows.push(...resourceCostAttributionReportRows(item, 'window_start'))
    windows += snapshots.length
    sourceTypes.push('15_minute_snapshots')
  }

  return {
    source: 'system_usage_rollups_and_snapshots',
    measurement: 'application_attribution_not_provider_billing',
    range: { from: requested.from, to: new Date(end).toISOString() },
    rows,
    coverage: {
      status: windows ? 'partial_attribution' : 'missing',
      windows,
      source_types: sourceTypes,
      truncated_top_rows: true,
    },
  }
}
