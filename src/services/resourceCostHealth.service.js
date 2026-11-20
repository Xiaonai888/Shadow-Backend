import { getResourceCostUploadAuditHealth } from './resourceCostUploadAudit.service.js'

const HOUR_MS = 3_600_000
const MAX_METRIC_ROWS = 80
const SOURCE_SPECS = Object.freeze([
  { key: 'render', table: 'render_bandwidth_hourly', field: 'hour_start', columns: 'hour_start', maxAgeHours: 4, eventDriven: false },
  { key: 'supabase', table: 'resource_cost_provider_observations', field: 'observed_at', columns: 'observed_at,metric,status,value', provider: 'supabase', maxAgeHours: 3, eventDriven: false },
  { key: 'cloudflare_r2', table: 'resource_cost_provider_observations', field: 'observed_at', columns: 'observed_at,metric,status,value', provider: 'cloudflare_r2', maxAgeHours: 3, eventDriven: false },
  { key: 'upload_audit', table: 'resource_cost_upload_hourly', field: 'hour_start', columns: 'hour_start', eventDriven: true },
  { key: 'application', table: 'system_usage_snapshots', field: 'window_end', columns: 'window_end', eventDriven: true },
])

const REQUIRED_METRICS = Object.freeze({
  supabase: Object.freeze([
    'api.requests.provider_window',
    'api.auth.provider_window',
    'api.realtime.provider_window',
    'api.rest.provider_window',
    'api.storage.provider_window',
  ]),
  cloudflare_r2: Object.freeze([
    'storage.total.bytes',
    'storage.standard.bytes',
    'storage.infrequent.bytes',
    'storage.objects',
    'operations.requests',
  ]),
})

function presentEnvironment(...keys) {
  return keys.some((key) => typeof process.env[key] === 'string' && process.env[key].trim().length > 0)
}

function supabaseProjectAvailable() {
  if (presentEnvironment('SUPABASE_PROJECT_REF')) return true
  try {
    return /^[a-z0-9-]+\.supabase\.co$/i.test(new URL(String(process.env.SUPABASE_URL || '')).hostname)
  } catch {
    return false
  }
}

function environmentChecks() {
  return {
    supabase: {
      management_token_present: presentEnvironment('SUPABASE_MANAGEMENT_TOKEN', 'SYSTEM_SUPABASE_MANAGEMENT_TOKEN'),
      project_ref_available: supabaseProjectAvailable(),
    },
    cloudflare_r2: {
      metrics_token_present: presentEnvironment('CLOUDFLARE_R2_METRICS_TOKEN'),
      operations_token_present: presentEnvironment('CLOUDFLARE_API_TOKEN', 'SYSTEM_CLOUDFLARE_API_TOKEN'),
      account_id_present: presentEnvironment('CLOUDFLARE_ACCOUNT_ID', 'SYSTEM_CLOUDFLARE_ACCOUNT_ID', 'R2_ACCOUNT_ID'),
    },
  }
}

function safeDate(value) {
  if (typeof value !== 'string' || !value) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null
}

function safeCount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function sourceStatus(lastAt, now, spec) {
  if (!lastAt) return spec.eventDriven ? 'no_recorded_events' : 'no_measurements'
  if (spec.eventDriven) return 'recorded'
  return now - Date.parse(lastAt) <= spec.maxAgeHours * HOUR_MS ? 'recent' : 'delayed'
}

function sourceMetricDiagnostics(rows, spec, now) {
  if (!spec.provider) return null
  const expected = REQUIRED_METRICS[spec.provider] || []
  const recent = new Map()
  const measured = new Map()
  const cutoff = now - spec.maxAgeHours * HOUR_MS

  for (const row of rows) {
    const metric = String(row?.metric || '')
    const observed = Date.parse(row?.observed_at || '')
    if (!expected.includes(metric) || !Number.isFinite(observed) || observed < cutoff || observed > now + HOUR_MS) continue

    if (!recent.has(metric)) {
      recent.set(metric, {
        observed_at: safeDate(row.observed_at),
        status: String(row.status || 'unknown').slice(0, 32),
        has_value: safeCount(row.value) !== null,
      })
    }

    if (row.status === 'ok' && safeCount(row.value) !== null && !measured.has(metric)) {
      measured.set(metric, safeDate(row.observed_at))
    }
  }

  const observedKnownMetrics = rows.some((row) => expected.includes(String(row?.metric || '')))
  if (!observedKnownMetrics) {
    return { status: 'unknown', expected_metrics: expected.length, measured_metrics: null, missing: [], latest: {} }
  }

  const missing = expected.filter((metric) => !measured.has(metric))
  return {
    status: measured.size === 0 ? 'missing' : missing.length ? 'partial' : 'complete',
    expected_metrics: expected.length,
    measured_metrics: measured.size,
    missing,
    latest: Object.fromEntries(recent),
  }
}

async function latestSource(database, spec, now) {
  try {
    let query = database.from(spec.table).select(spec.columns)
    if (spec.provider) query = query.eq('provider', spec.provider)
    const { data, error } = await query.order(spec.field, { ascending: false }).limit(spec.provider ? MAX_METRIC_ROWS : 1)
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
    const latest = safeDate(data[0]?.[spec.field])
    const ageMinutes = latest ? Math.max(0, Math.round((now - Date.parse(latest)) / 60_000)) : null
    const metrics = sourceMetricDiagnostics(data, spec, now)

    return {
      table: spec.table,
      status: sourceStatus(latest, now, spec),
      latest_at: latest,
      age_minutes: ageMinutes,
      expected_interval: spec.eventDriven ? 'event_driven' : 'provider_hourly',
      ...(metrics ? { metrics } : {}),
    }
  } catch {
    return { table: spec.table, status: 'query_failed', latest_at: null, age_minutes: null }
  }
}

function classifyError(error) {
  const source = String(error || '').slice(0, 300)
  const http = source.match(/HTTP\s+(\d{3})/i)
  if (http) {
    if (http[1] === '401') return 'http_401_invalid_credentials'
    if (http[1] === '403') return 'http_403_insufficient_permissions'
    if (http[1] === '429') return 'http_429_rate_limited'
    return `http_${http[1]}`
  }
  if (/abort|timeout/i.test(source)) return 'provider_timeout'
  if (/permission|forbidden|unauthori[sz]ed|access denied/i.test(source)) return 'provider_permission_denied'
  if (/graphql|missing data|invalid|unexpected|no data/i.test(source)) return 'provider_response_unavailable'
  return source ? 'provider_request_failed' : null
}

function providerInfo(state, key) {
  const value = state?.[key] || {}
  const status = typeof value.status === 'string' ? value.status : 'unknown'
  const diagnostics = key === 'render' ? value.sync_diagnostics : null
  const missing = Array.isArray(value.missing)
    ? value.missing.filter((item) => /^[A-Z][A-Z0-9_]{2,80}$/.test(String(item))).slice(0, 8)
    : []
  const issues = Array.isArray(value.errors)
    ? value.errors.slice(0, 5).map((entry) => ({
        source: ['storage_metrics', 'operations_analytics'].includes(entry?.source) ? entry.source : 'provider',
        code: classifyError(entry?.message),
      }))
    : []

  return {
    sync_status: key === 'render' && status === 'ok' && Number(diagnostics?.hours_without_breakdown) > 0 ? 'partial' : status,
    last_checked_at: safeDate(value.checked_at),
    missing_environment: missing,
    error_code: classifyError(value.error),
    source_issues: issues,
  }
}

function classifyWarnings(sources, providers, uploads) {
  const warnings = []
  if (SOURCE_SPECS.some(({ key }) => sources[key].status === 'table_missing')) warnings.push('database_setup_incomplete')
  if (SOURCE_SPECS.some(({ key }) => sources[key].status === 'query_failed')) warnings.push('database_source_unavailable')

  for (const key of ['render', 'supabase', 'cloudflare_r2']) {
    if (sources[key].status === 'delayed') warnings.push(`${key}_measurements_delayed`)
    if (sources[key].status === 'no_measurements') warnings.push(`${key}_measurements_missing`)
    if (['missing', 'partial'].includes(sources[key].metrics?.status)) warnings.push(`${key}_metrics_incomplete`)
  }

  for (const key of ['render', 'supabase', 'cloudflare_r2']) {
    const status = providers[key]?.sync_status
    if (status === 'not_configured') warnings.push(`${key}_not_configured`)
    if (status === 'error') warnings.push(`${key}_provider_sync_error`)
    if (status === 'partial' || status === 'empty') warnings.push(`${key}_provider_partial`)
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
  const entries = await Promise.all(SOURCE_SPECS.map(async (spec) => [spec.key, await latestSource(database, spec, current)]))
  const sources = Object.fromEntries(entries)
  const providers = {
    render: {
      ...providerInfo(state, 'render'),
      service_ids: state?.render?.service_ids || [],
      sync_diagnostics: state?.render?.sync_diagnostics ?? null,
      hourly_history: state?.render?.hourly_history ?? null,
      sync_error: typeof state?.render?.error === 'string' ? classifyError(state.render.error) : null,
    },
    supabase: providerInfo(state, 'supabase'),
    cloudflare_r2: providerInfo(state, 'cloudflare_r2'),
    last_sync_at: safeDate(state?.last_sync_at),
  }

  return {
    generated_at: new Date(current).toISOString(),
    database_readable: SOURCE_SPECS.every(({ key }) => !['table_missing', 'query_failed'].includes(sources[key].status)),
    verified_complete: false,
    sources,
    providers,
    environment_checks: environmentChecks(),
    upload_queue: {
      pending_attempts: uploads.pending_attempts ?? 0,
      pending_groups: uploads.pending_groups ?? 0,
      failed_flushes: uploads.failed_flushes ?? 0,
      overflow_events: uploads.overflow_events ?? 0,
      last_flush_at: safeDate(uploads.last_flush_at),
      last_error_at: safeDate(uploads.last_error_at),
      durability: uploads.durability || 'memory_until_successful_batch_commit',
    },
    warnings: classifyWarnings(sources, providers, uploads),
    interpretation: 'Provider metrics may be partial even when recent. Missing metric values are not zero. Environment checks only report whether configured names exist, not their values, validity or permissions. Provider billing remains unverified.',
  }
}
