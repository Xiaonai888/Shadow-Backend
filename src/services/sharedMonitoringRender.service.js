import { resourceCostRange, resourceCostTimestamp } from '../resourceCostMath.service.js'
import { buildResourceCostSummary } from '../resourceCostSummary.service.js'
import { readSharedMonitoringRows } from './sharedMonitoringRows.service.js'

const RENDER_COLUMNS = 'service_id,hour_start,total_bytes,http_response_bytes,service_initiated_bytes,websocket_response_bytes,private_link_bytes,breakdown_available'
const SERVICE_ID_PATTERN = /^srv-[a-z0-9-]+$/i

export function sharedMonitoringRenderServiceIds(additional = []) {
  const values = [
    process.env.RENDER_SERVICE_ID,
    process.env.SYSTEM_RENDER_SERVICE_ID,
    ...String(process.env.RENDER_SERVICE_IDS || '').split(/[\s,;]+/),
    ...(Array.isArray(additional) ? additional : []),
  ]

  return [...new Set(values.map((value) => String(value || '').trim()).filter((value) => SERVICE_ID_PATTERN.test(value)))].sort()
}

export async function readSharedMonitoringRender({
  from,
  to,
  asOf = new Date(),
  serviceIds = [],
} = {}, { client = null } = {}) {
  const requested = resourceCostRange(from, to, 31)
  const endMs = Math.min(resourceCostTimestamp(requested.to), resourceCostTimestamp(asOf))
  if (endMs <= resourceCostTimestamp(requested.from)) throw new RangeError('Render monitoring period must precede the measurement time.')
  const range = { from: requested.from, to: new Date(endMs).toISOString() }
  const configured = sharedMonitoringRenderServiceIds(serviceIds)

  const rows = await readSharedMonitoringRows({
    table: 'render_bandwidth_hourly',
    columns: RENDER_COLUMNS,
    timeField: 'hour_start',
    from: range.from,
    to: range.to,
    tieBreakers: ['service_id'],
  }, client)

  const report = buildResourceCostSummary({
    ...range,
    asOf,
    serviceIds: configured,
    renderRows: rows,
  })
  const observed = [...new Set(rows.map((row) => String(row.service_id || '').trim()).filter(Boolean))].sort()

  return {
    source: 'render_bandwidth_hourly',
    measurement: 'provider_outbound_bytes_not_invoice_cost',
    range,
    configured_service_ids: configured,
    observed_service_ids: observed,
    configured_without_measurements: configured.filter((id) => !observed.includes(id)),
    observed_not_configured: observed.filter((id) => !configured.includes(id)),
    service_inventory_verified: false,
    billing_authoritative: false,
    coverage: report.totals.render.coverage,
    rows,
    totals: report.totals.render.observed_service_hours > 0 ? report.totals.render : null,
    days: report.days.map((day) => ({
      date: day.date,
      period_start: day.period_start,
      period_end: day.period_end,
      render: day.render.observed_service_hours > 0 ? day.render : null,
      coverage: day.render.coverage,
    })),
  }
}
