import { resourceCostRange, resourceCostTimestamp } from '../resourceCostMath.service.js'
import { readSharedMonitoringRender } from './sharedMonitoringRender.service.js'
import { readSharedMonitoringProviders } from './sharedMonitoringProviders.service.js'
import { readSharedMonitoringApplication } from './sharedMonitoringApplication.service.js'

export async function readSharedMonitoringSnapshot({
  from,
  to,
  asOf = new Date(),
  serviceIds = [],
  includeApplication = true,
} = {}, { client = null } = {}) {
  const requested = resourceCostRange(from, to, 31)
  const measuredAt = resourceCostTimestamp(asOf)
  const end = Math.min(resourceCostTimestamp(requested.to), measuredAt)
  if (end <= resourceCostTimestamp(requested.from)) {
    throw new RangeError('Shared monitoring period must precede the measurement time.')
  }

  const range = { from: requested.from, to: new Date(end).toISOString() }
  const options = { ...range, asOf: new Date(measuredAt), serviceIds }
  const dependencies = { client }
  const readers = [
    ['render', () => readSharedMonitoringRender(options, dependencies)],
    ['provider_observations', () => readSharedMonitoringProviders(options, dependencies)],
  ]
  if (includeApplication) {
    readers.push(['application', () => readSharedMonitoringApplication(options, dependencies)])
  }

  const settled = await Promise.allSettled(readers.map(([, reader]) => reader()))
  const results = { render: null, provider_observations: null, application: null }
  const sourceErrors = {}
  let succeeded = 0

  for (let index = 0; index < readers.length; index += 1) {
    const [name] = readers[index]
    const item = settled[index]
    if (item.status === 'fulfilled') {
      results[name] = item.value
      succeeded += 1
    } else {
      sourceErrors[name] = String(item.reason?.message || item.reason || 'Monitoring source unavailable').slice(0, 240)
    }
  }

  return {
    mode: 'shared_read_only',
    range,
    measured_at: new Date(measuredAt).toISOString(),
    query_status: succeeded === readers.length ? 'ok' : succeeded ? 'partial' : 'unavailable',
    source_errors: sourceErrors,
    source_reads: readers.length,
    source_reads_succeeded: succeeded,
    application_requested: Boolean(includeApplication),
    ...results,
  }
}
