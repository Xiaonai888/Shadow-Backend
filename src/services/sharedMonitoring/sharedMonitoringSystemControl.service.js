import { readSharedMonitoringSnapshot } from './sharedMonitoringSnapshot.service.js'

export async function readSharedSystemControlProviderUsage({
  from,
  to,
  asOf = new Date(),
  serviceIds = [],
} = {}, { client = null } = {}) {
  const shared = await readSharedMonitoringSnapshot({
    from,
    to,
    asOf,
    serviceIds,
    includeApplication: false,
  }, { client })

  const render = shared.render
  const totals = render?.totals || null
  const observations = shared.provider_observations

  return {
    source: 'shared_monitoring',
    range: shared.range,
    measured_at: shared.measured_at,
    query_status: shared.query_status,
    source_errors: shared.source_errors,
    render: {
      source: 'render_bandwidth_hourly',
      status: !render ? 'unavailable' : !totals ? 'missing' : render.coverage,
      total_bytes: totals?.total_bytes ?? null,
      http_response_bytes: totals?.http_response_bytes ?? null,
      service_initiated_bytes: totals?.service_initiated_bytes ?? null,
      websocket_response_bytes: totals?.websocket_response_bytes ?? null,
      private_link_bytes: totals?.private_link_bytes ?? null,
      observed_service_hours: totals?.observed_service_hours ?? 0,
      expected_service_hours: totals?.expected_service_hours ?? null,
      configured_service_ids: render?.configured_service_ids || [],
      observed_service_ids: render?.observed_service_ids || [],
      configured_without_measurements: render?.configured_without_measurements || [],
      service_inventory_verified: false,
      billing_authoritative: false,
    },
    provider_observations: observations ? {
      source: observations.source,
      providers: observations.providers,
      rows: observations.rows,
      invoice_cost_verified: false,
    } : null,
    application_attribution: 'not_requested',
    invoice_cost_usd: null,
  }
}
