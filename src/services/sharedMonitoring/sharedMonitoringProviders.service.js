import { resourceCostRange, resourceCostTimestamp } from '../resourceCostMath.service.js'
import { readSharedMonitoringRows } from './sharedMonitoringRows.service.js'

const HOUR_MS = 3_600_000
const PROVIDER_COLUMNS = 'provider,metric,scope,observed_hour,observed_at,period_start,period_end,kind,unit,value,status'

export async function readSharedMonitoringProviders({
  from,
  to,
  asOf = new Date(),
} = {}, { client = null } = {}) {
  const range = resourceCostRange(from, to, 31)
  const startMs = resourceCostTimestamp(range.from)
  const endMs = Math.min(resourceCostTimestamp(range.to), resourceCostTimestamp(asOf))
  if (endMs <= startMs) throw new RangeError('Provider monitoring period must precede the measurement time.')

  const observationRange = {
    from: new Date(startMs - 27 * HOUR_MS).toISOString(),
    to: new Date(Math.min(resourceCostTimestamp(asOf), endMs + 48 * HOUR_MS)).toISOString(),
  }

  const rows = await readSharedMonitoringRows({
    table: 'resource_cost_provider_observations',
    columns: PROVIDER_COLUMNS,
    timeField: 'observed_at',
    from: observationRange.from,
    to: observationRange.to,
    tieBreakers: ['provider', 'metric', 'scope'],
  }, client)

  return {
    source: 'resource_cost_provider_observations',
    range: { from: range.from, to: new Date(endMs).toISOString() },
    observation_range: observationRange,
    rows,
    providers: [...new Set(rows.map((row) => String(row.provider || '').trim()).filter(Boolean))].sort(),
    invoice_cost_verified: false,
  }
}
