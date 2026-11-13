import { getResourceCostUploadAuditHealth } from './resourceCostUploadAudit.service.js'

const HOUR_MS = 3_600_000

const SOURCES = Object.freeze([
  { key: 'render', table: 'render_bandwidth_hourly', field: 'hour_start', columns: 'hour_start', maxAgeHours: 4, eventDriven: false },
  { key: 'supabase', table: 'resource_cost_provider_observations', field: 'observed_at', columns: 'observed_at', provider: 'supabase', maxAgeHours: 3, eventDriven: false },
  { key: 'cloudflare_r2', table: 'resource_cost_provider_observations', field: 'observed_at', columns: 'observed_at', provider: 'cloudflare_r2', maxAgeHours: 3, eventDriven: false },
  { key: 'upload_audit', table: 'resource_cost_upload_hourly', field: 'hour_start', columns: 'hour_start', eventDriven: true },
  { key: 'application', table: 'system_usage_snapshots', field: 'window_end', columns: 'window_end', eventDriven: true },
])

function safeDate(value) {
  if (typeof value !== 'string' || !value) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null
}

function sourceStatus(lastAt, now, spec) {
  if (!lastAt) return spec.eventDriven ? 'no_recorded_events' : 'no_measurements'
  if (spec.eventDriven) return 'recorded'
  const age = now - Date.parse(lastAt)
  return age <= spec.maxAgeHours * HOUR_MS ? 'recent' : 'delayed'
}

async function latestSource(database, spec, now) {
  try {
    let query = database.from(spec.table).select(spec.columns)
    if (spec.provider) query = query.eq('provider', spec.provider)
    const { data, error } = await query.order(spec.field, { ascending: false }).limit(1)
    if (error) {
      const code = String(error.code || '')
      return {
        table: spec.table,
        status: ['42P01', 'PGRST205'].includes(code) ? 'table_missing' : 'query_failed',
        latest_at: null,
        age_minutes: null,
      }
    }
    if (!Array.isArray(data)) {
      return { table: spec.table, status: 'query_failed', latest_at: null, age_minutes: null }
    }
    const last = safeDate(data[0]?.[spec.field])
    const ageMinutes = last ? Math.max(0, Math.round((now - Date.parse(last)) / 60_000)) : null
    return {
      table: spec.table,
      status: sourceStatus(last, now, spec),
      latest_at: last,
      age_minutes: ageMinutes,
      expected_interval: spec.eventDriven ? 'event_driven' : 'provider_hourly',
    }
  } catch {
    return { table: spec.table, status: 'query_failed', latest_at: null, age_minutes: null }
  }
}

function providerInfo(state, key) {
  const value = state?.[key] || {}
  return {
    sync_status: typeof value.status === 'string' ? value.status : 'unknown',
    last_checked_at: safeDate(value.checked_at),
  }
}

function classifyWarnings(sources, providers, uploads) {
  const warnings = []
  if (SOURCES.some(({ key }) => sources[key].status === 'table_missing')) warnings.push('database_setup_incomplete')
  if (SOURCES.some(({ key }) => sources[key].status === 'query_failed')) warnings.push('database_source_unavailable')
  for (const key of ['render', 'supabase', 'cloudflare_r2']) {
    if (sources[key].status === 'delayed') warnings.push(`${key}_measurements_delayed`)
    if (sources[key].status === 'no_measurements') warnings.push(`${key}_measurements_missing`)
  }
  for (const key of ['render', 'supabase', 'cloudflare_r2']) {
    const status = providers[key]?.sync_status
    if (status === 'not_configured') warnings.push(`${key}_not_configured`)
    if (status === 'error') warnings.push(`${key}_provider_sync_error`)
  }
  if (uploads.failed_flushes > 0) warnings.push('upload_audit_save_failures')
  if (uploads.pending_attempts > 0) warnings.push('upload_audit_not_yet_persisted')
  if (uploads.overflow_events > 0) warnings.push('upload_audit_overflow')
  return warnings
}

export async function getResourceCostHealth({ client, providerState, uploadHealth, now = new Date() } = {}) {
  const current = new Date(now).getTime()
  if (!Number.isFinite(current)) throw new TypeError('A valid time is required.')
  const database = client || (await import('../config/supabase.js')).supabase
  const state = providerState || (await import('./systemUsagePersistence.service.js')).getSystemUsageProviderState()
  const uploads = uploadHealth || getResourceCostUploadAuditHealth()
  const entries = await Promise.all(SOURCES.map(async (spec) => [spec.key, await latestSource(database, spec, current)]))
  const sources = Object.fromEntries(entries)
  const providers = {
    render: providerInfo(state, 'render'),
    supabase: providerInfo(state, 'supabase'),
    cloudflare_r2: providerInfo(state, 'cloudflare_r2'),
    last_sync_at: safeDate(state?.last_sync_at),
  }
  const tablesReady = SOURCES.every(({ key }) => !['table_missing', 'query_failed'].includes(sources[key].status))
  const warnings = classifyWarnings(sources, providers, uploads)
  return {
    generated_at: new Date(current).toISOString(),
    database_readable: tablesReady,
    verified_complete: false,
    sources,
    providers,
    upload_queue: {
      pending_attempts: uploads.pending_attempts ?? 0,
      pending_groups: uploads.pending_groups ?? 0,
      failed_flushes: uploads.failed_flushes ?? 0,
      overflow_events: uploads.overflow_events ?? 0,
      last_flush_at: safeDate(uploads.last_flush_at),
      last_error_at: safeDate(uploads.last_error_at),
      durability: uploads.durability || 'memory_until_successful_batch_commit',
    },
    warnings,
    interpretation: 'A recent source does not prove complete usage or accurate billing. Event-driven sources may have no rows when idle. Unfinalized direct R2 PUTs and network overhead remain unmeasured.',
  }
}
