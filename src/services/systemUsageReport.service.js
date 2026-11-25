import { supabase } from '../config/supabase.js'
import { getSystemUsageHistory } from './systemUsagePersistence.service.js'
import { getRecentRequestEvidence, getHistoricalErrorEvidence } from './trafficDiagnostic.service.js'

const REPORT_MAX_RANGE_MS = 31 * 24 * 60 * 60 * 1000
const INCIDENT_PAGE_SIZE = 500
const REPORT_INCIDENT_LIMIT = 5000
const ROUTE_TARGET_LIMIT = 5

function safeNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(0, number) : 0
}

function csvCell(value) {
  const text = String(value ?? '')
  return `"${text.replaceAll('"', '""')}"`
}

function formatBytes(bytes) {
  const value = safeNumber(bytes)

  if (value >= 1024 ** 3) {
    return `${(value / 1024 ** 3).toFixed(2)} GB`
  }

  if (value >= 1024 ** 2) {
    return `${(value / 1024 ** 2).toFixed(2)} MB`
  }

  if (value >= 1024) {
    return `${(value / 1024).toFixed(2)} KB`
  }

  return `${Math.round(value)} B`
}

function iso(value) {
  const time = new Date(value || '').getTime()
  return Number.isFinite(time) ? new Date(time).toISOString() : null
}

function filenameTime(value) {
  const time = iso(value)
  return time
    ? time.replaceAll(':', '-').replace('.000Z', 'Z')
    : 'unknown'
}

function rangeSlug(from, to) {
  return `${filenameTime(from)}_to_${filenameTime(to)}`
}

function normalizeRange(from, to) {
  const fromMs = new Date(from || '').getTime()
  const requestedToMs = new Date(to || '').getTime()

  if (!Number.isFinite(fromMs) || !Number.isFinite(requestedToMs)) {
    throw new Error('Valid from and to date-times are required.')
  }

  if (requestedToMs <= fromMs) {
    throw new Error('Report end time must be after start time.')
  }

  if (requestedToMs - fromMs > REPORT_MAX_RANGE_MS) {
    throw new Error('Report range cannot exceed 31 days.')
  }

  const effectiveToMs = Math.min(requestedToMs, Date.now())

  if (effectiveToMs <= fromMs) {
    throw new Error('Report range must include past or current time.')
  }

  return {
    from: new Date(fromMs).toISOString(),
    requested_to: new Date(requestedToMs).toISOString(),
    to: new Date(effectiveToMs).toISOString(),
  }
}

async function loadIncidentsForRange(from, to) {
  const rows = []

  for (
    let offset = 0;
    offset < REPORT_INCIDENT_LIMIT;
    offset += INCIDENT_PAGE_SIZE
  ) {
    const { data, error } = await supabase
      .from('system_usage_incidents')
      .select(
        'id,fingerprint,status,severity,feature,source_route,dependency,first_seen_at,last_seen_at,resolved_at,recurrence_count,evidence,created_at,updated_at'
      )
      .lt('first_seen_at', to)
      .gte('last_seen_at', from)
      .order('last_seen_at', { ascending: false })
      .range(offset, offset + INCIDENT_PAGE_SIZE - 1)

    if (error) throw error

    const page = Array.isArray(data) ? data : []
    rows.push(...page)

    if (page.length < INCIDENT_PAGE_SIZE) break
  }

  return rows.slice(0, REPORT_INCIDENT_LIMIT)
}

function aggregateBy(rows, keySelector) {
  const map = new Map()

  for (const row of rows || []) {
    const key = String(keySelector(row) || 'UNKNOWN')
    const current = map.get(key) || {
      key,
      requests: 0,
      bytes: 0,
      errors: 0,
    }

    current.requests += safeNumber(row.count)
    current.bytes += safeNumber(row.bytes)
    current.errors += safeNumber(row.errors)
    map.set(key, current)
  }

  return [...map.values()].sort(
    (a, b) =>
      b.bytes - a.bytes ||
      b.requests - a.requests
  )
}

function diagnosticLabel(item) {
  if (item.errors > 0) {
    return 'errors_observed'
  }

  if (
    item.http_requests > 0 &&
    item.supabase_calls >= 8 &&
    item.supabase_per_http >= 8
  ) {
    return 'database_fanout'
  }

  if (item.supabase_calls > 0) {
    return 'database_activity'
  }

  return 'no_database_fanout'
}

function diagnosticMeaning(label) {
  if (label === 'database_fanout') {
    return 'High DB calls per HTTP observed; this alone does not prove a loop or polling bug.'
  }

  if (label === 'errors_observed') {
    return 'Errors were observed; inspect status/error evidence before changing code.'
  }

  if (label === 'database_activity') {
    return 'Database activity observed without fanout-level evidence.'
  }

  return 'No database fanout evidence in the selected range.'
}


function safeDiagnosticText(value, limit = 180) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, limit)
}

function safeDiagnosticPath(value, allowQuery = false) {
  const raw = safeDiagnosticText(value, 300)
  const separator = raw.indexOf('?')
  const path = (separator < 0 ? raw : raw.slice(0, separator))
    .replace(/(\/orders\/(?:status\/)?)\w[^/\s]*/gi, '$1:id')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, ':id')
    .replace(/\b[a-f0-9]{24,}\b/gi, ':id')
    .replace(/\b[a-z0-9_-]{48,}\b/gi, ':id')
    .replace(/\/\d{6,}(?=\/|$)/g, '/:id')
    .slice(0, 160)

  if (!allowQuery || separator < 0) return path

  const safeParams = []
  for (const param of raw.slice(separator + 1).split('&')) {
    const equal = param.indexOf('=')
    if (equal <= 0) continue
    const key = param.slice(0, equal).toLowerCase()
    const value = param.slice(equal + 1)
    if (!['sort', 'cache', 'status'].includes(key)) continue
    if (!/^[a-z0-9_-]{1,32}$/i.test(value)) continue
    safeParams.push(`${key}=${value}`)
    if (safeParams.length >= 3) break
  }
  return `${path}${safeParams.length ? `?${safeParams.join('&')}` : ''}`.slice(0, 180)
}

function diagnosticSignal(item) {
  const status = safeNumber(item.http_status)
  const upstream = safeNumber(item.provider_http_status)
  const route = String(item.route || '')
  const code = `${item.error_code || ''} ${item.response_code || ''}`.toUpperCase()
  const payment = /PDF|PAYMENT|CHECKOUT|BINANCE|ABA/.test(route.toUpperCase())
  const serverError = status >= 500 || upstream >= 500

  if (serverError && payment) {
    return {
      priority: 'urgent',
      signal: 'Payment route returned a server or provider error; cause not proven',
      next_check: 'Inspect provider verification logs and payment ledger; preserve idempotency and prevent duplicate unlock.',
      category: 'payment_verification_failure',
    }
  }

  if (/57014|QUERY_CANCELED|QUERY_CANCELLED|STATEMENT_TIMEOUT/.test(code)) {
    return {
      priority: 'high',
      signal: 'Database query cancelled or timed out (inferred from error code)',
      next_check: 'Inspect Supabase slow SQL, locks, execution time and statement_timeout.',
      category: 'database_query_cancelled',
    }
  }

  if (serverError && (status === 503 || upstream === 503 || upstream === 502 || upstream === 504)) {
    return {
      priority: 'high',
      signal: 'Service unavailable or upstream failure; specific cause not yet established',
      next_check: 'Check dependency status, server logs, timeout and retry/backoff evidence.',
      category: 'service_unavailable',
    }
  }

  if (serverError) {
    return {
      priority: 'high',
      signal: 'Server-side failure observed; root cause needs logs',
      next_check: 'Check handler logs, dependency errors and request trace for this route.',
      category: 'server_failure',
    }
  }

  if (status === 429 || upstream === 429) {
    return {
      priority: 'medium',
      signal: 'Request was rate limited; may be expected protection',
      next_check: 'Compare legitimate traffic with rate-limit policy before changing limits.',
      category: 'rate_limited',
    }
  }

  if (status === 408 || upstream === 408) {
    return {
      priority: 'medium',
      signal: 'Request timed out; origin of timeout not established',
      next_check: 'Inspect request duration and the upstream that exceeded its timeout.',
      category: 'request_timeout',
    }
  }

  if (status === 401 || status === 403) {
    return {
      priority: 'low',
      signal: 'Authentication or permission rejection; may be expected',
      next_check: 'Confirm permission rules and user-facing behavior if the rejection is unexpected.',
      category: 'authentication_or_permission',
    }
  }

  if (status === 404) {
    return {
      priority: 'low',
      signal: 'Resource not found; may be expected',
      next_check: 'Check link targets and deleted or unpublished resources if users are affected.',
      category: 'not_found',
    }
  }

  return {
    priority: status >= 400 || upstream >= 400 ? 'medium' : 'low',
    signal: 'An error was recorded; stored evidence does not identify a verified cause',
    next_check: 'Inspect relevant application and provider logs for this route and time.',
    category: 'unclassified_error',
  }
}

const ERROR_PRIORITY_ORDER = { urgent: 0, high: 1, medium: 2, low: 3 }

function buildActionableErrorDiagnostics(entries = [], limit = 60) {
  return (Array.isArray(entries) ? entries : [])
    .map((item) => {
      const route = safeDiagnosticPath(item.route || 'UNKNOWN', true)
      const httpStatus = safeNumber(item.http_status)
      const providerStatus = safeNumber(item.provider_http_status)
      const errorCode = safeDiagnosticText(
        item.root_cause_code || item.response_code || `HTTP_${httpStatus}`,
        64
      ).replace(/[^a-z0-9_:-]/gi, '_')
      const responseCode = safeDiagnosticText(item.response_code || '-', 64)
        .replace(/[^a-z0-9_:-]/gi, '_')
      const signal = diagnosticSignal({
        route,
        http_status: httpStatus,
        provider_http_status: providerStatus,
        error_code: errorCode,
        response_code: responseCode,
      })
      return {
        route,
        http_status: httpStatus || '-',
        error_code: errorCode,
        response_code: responseCode,
        stage: safeDiagnosticText(item.diagnostic_stage || 'unknown', 64)
          .replace(/[^a-z0-9_:-]/gi, '_'),
        provider: safeDiagnosticText(item.provider || 'APPLICATION', 64)
          .replace(/[^a-z0-9_:-]/gi, '_'),
        provider_http_status: providerStatus || '-',
        target: safeDiagnosticPath(item.target || '-'),
        count: safeNumber(item.count),
        windows_seen: safeNumber(item.windows_seen) || 1,
        first_seen_at: iso(item.first_seen_at || item.window_start),
        last_seen_at: iso(item.last_seen_at),
        priority: signal.priority,
        signal: signal.signal,
        next_check: signal.next_check,
        category: signal.category,
        stage_is_unknown: !item.diagnostic_stage || item.diagnostic_stage === 'unknown',
      }
    })
    .sort((a, b) =>
      ERROR_PRIORITY_ORDER[a.priority] - ERROR_PRIORITY_ORDER[b.priority] ||
      b.count - a.count ||
      String(b.last_seen_at || '').localeCompare(String(a.last_seen_at || ''))
    )
    .slice(0, limit)
}

function summarizeActionableErrorDiagnostics(rows, availableEntries, coverage) {
  const listed = Array.isArray(rows) ? rows : []
  const all = Array.isArray(availableEntries) ? availableEntries : []
  return {
    available_groups: Math.max(all.length, safeNumber(coverage?.distinct_error_groups)),
    displayed_groups: listed.length,
    capped: all.length > listed.length || coverage?.detail_capped === true,
    high_priority_groups_displayed: listed.filter((item) =>
      item.priority === 'urgent' || item.priority === 'high'
    ).length,
    unknown_stage_groups_displayed: listed.filter((item) => item.stage_is_unknown).length,
    displayed_bounded_error_events: listed.reduce((sum, item) => sum + item.count, 0),
    note: 'Evidence is bounded, may overlap total error counters, and is not proof of root cause.',
  }
}

function buildFanoutCandidates(routes = []) {
  return (Array.isArray(routes) ? routes : [])
    .filter((route) =>
      safeNumber(route.http_requests) > 0 &&
      safeNumber(route.supabase_calls) >= 8 &&
      safeNumber(route.supabase_per_http) >= 8
    )
    .slice(0, 20)
    .map((route) => ({
      route: safeDiagnosticPath(route.route || 'UNKNOWN', true),
      http_requests: safeNumber(route.http_requests),
      supabase_calls: safeNumber(route.supabase_calls),
      supabase_per_http: safeNumber(route.supabase_per_http),
      errors: safeNumber(route.errors),
      signal: 'Elevated DB calls per HTTP; this does not establish a loop.',
    }))
}

function targetKey(row) {
  return [
    String(row.dependency || 'UNKNOWN').toUpperCase(),
    String(row.operation_method || 'UNKNOWN').toUpperCase(),
    String(row.target_path || '/'),
  ].join(' ')
}

function buildRouteDiagnostics(rows = []) {
  const routes = new Map()

  for (const row of rows) {
    if (row.kind !== 'http_response' && row.kind !== 'external_request') continue
    if (row.source_route === 'OTHER / UNLISTED') continue
    const route = String(row.source_route || 'UNKNOWN')
    const current = routes.get(route) || {
      route,
      http_requests: 0,
      external_calls: 0,
      supabase_calls: 0,
      errors: 0,
      target_map: new Map(),
    }

    const count = safeNumber(row.count)
    current.errors += safeNumber(row.errors)

    if (row.kind === 'http_response') {
      current.http_requests += count
    }

    if (row.kind === 'external_request') {
      current.external_calls += count

      const dependency = String(row.dependency || '').toUpperCase()
      if (dependency === 'SUPABASE') {
        current.supabase_calls += count
      }

      const key = targetKey(row)
      const target = current.target_map.get(key) || {
        target: key,
        dependency,
        method: String(row.operation_method || 'UNKNOWN').toUpperCase(),
        path: String(row.target_path || '/'),
        calls: 0,
        errors: 0,
        duration_ms: 0,
      }

      target.calls += count
      target.errors += safeNumber(row.errors)
      target.duration_ms += safeNumber(row.avg_ms) * count
      current.target_map.set(key, target)
    }

    routes.set(route, current)
  }

  return [...routes.values()]
    .map((item) => {
      const supabasePerHttp = item.http_requests > 0
        ? Number((item.supabase_calls / item.http_requests).toFixed(2))
        : null

      const targets = [...item.target_map.values()]
        .map((target) => ({
          target: target.target,
          dependency: target.dependency,
          method: target.method,
          path: target.path,
          calls: target.calls,
          errors: target.errors,
          avg_ms: target.calls > 0
            ? Number((target.duration_ms / target.calls).toFixed(1))
            : 0,
        }))
        .sort(
          (a, b) =>
            b.calls - a.calls ||
            b.errors - a.errors ||
            b.avg_ms - a.avg_ms
        )
        .slice(0, ROUTE_TARGET_LIMIT)

      const result = {
        route: item.route,
        http_requests: item.http_requests,
        external_calls: item.external_calls,
        supabase_calls: item.supabase_calls,
        supabase_per_http: supabasePerHttp,
        errors: item.errors,
        targets,
      }

      result.diagnostic = diagnosticLabel(result)
      result.interpretation = diagnosticMeaning(result.diagnostic)
      result.top_target = targets[0]?.target || ''
      result.top_target_calls = targets[0]?.calls || 0

      return result
    })
    .sort(
      (a, b) =>
        b.supabase_calls - a.supabase_calls ||
        b.http_requests - a.http_requests
    )
}

function buildTargetDiagnostics(routes = []) {
  const rows = []

  for (const route of routes) {
    for (const target of route.targets || []) {
      rows.push({
        route: route.route,
        diagnostic: route.diagnostic,
        http_requests: route.http_requests,
        supabase_per_http: route.supabase_per_http,
        ...target,
      })
    }
  }

  return rows.sort(
    (a, b) =>
      b.calls - a.calls ||
      b.errors - a.errors ||
      b.avg_ms - a.avg_ms
  )
}

function filterRecentEvidence(range) {
  const fromMs = new Date(range.from).getTime()
  const toMs = new Date(range.to).getTime()

  return getRecentRequestEvidence()
    .filter((item) => {
      const time = new Date(item?.time || 0).getTime()
      return Number.isFinite(time) && time >= fromMs && time <= toMs
    })
    .sort(
      (a, b) =>
        new Date(b.time || 0).getTime() -
        new Date(a.time || 0).getTime()
    )
}

function buildSummaryStats(history, incidents, requestEvidence = []) {
  const rows = Array.isArray(history?.rows) ? history.rows : []

  const byProvider = aggregateBy(
    rows,
    (row) => row.dependency
  )

  const byFeature = aggregateBy(
    rows,
    (row) => row.feature
  )

  const incidentCounts = incidents.reduce((result, item) => {
  const status = String(item.status || 'OPEN').toUpperCase()
  if (['OPEN', 'INVESTIGATING', 'FIX_APPLIED'].includes(status)) result.active++
  else if (status === 'VERIFIED') result.verified++
  else if (['RESOLVED', 'ARCHIVED'].includes(status)) result.resolved++
  return result
}, { active: 0, verified: 0, resolved: 0 })

  const critical = incidents.filter(
    (item) =>
      String(item.severity || '').toLowerCase() === 'critical'
  ).length

  const routes = buildRouteDiagnostics(rows)
  const summary = history?.usage_summary || null
  const compact = Array.isArray(summary?.rows) ? summary.rows : []
  const categoryProviders = compact.length
    ? aggregateBy(compact.filter((row) => row.kind !== 'unclassified'), (row) => row.dependency)
    : byProvider
  const categoryFeatures = compact.length
    ? aggregateBy(compact.filter((row) => row.kind !== 'unclassified'), (row) => row.feature)
    : byFeature
  const includedCategories = compact.reduce((total, row) => total + safeNumber(row.count), 0)
  const summaryEvents = safeNumber(history?.totals?.requests)
  const unclassified = Math.max(0, summaryEvents - includedCategories) +
    compact.filter((row) => row.kind === 'unclassified').reduce((total, row) => total + safeNumber(row.count), 0)

  return {
    usage_summary: summary,
    detail_note: 'Route and target rankings use bounded stored detail; their counts can be lower than complete totals. OTHER/UNKNOWN cannot be assigned to an exact route.',
    data_coverage: history?.coverage || {},
    total_events_observed: summaryEvents,
    unclassified_events: compact.length ? Math.min(summaryEvents, unclassified) : null,
    providers: categoryProviders.slice(0, 10),
    features: categoryFeatures.slice(0, 10),
    routes: routes.slice(0, 30),
    route_targets: buildTargetDiagnostics(routes).slice(0, 100),
    recent_request_evidence: requestEvidence,
    diagnostics_note:
      'DB fanout means many database calls per HTTP request. It is not proof of a loop or polling bug unless repeated-window evidence also supports repetition.', 
    incidents: {
  total: incidents.length,
  ...incidentCounts,
  critical,
},
  }
}

function markdownTable(headers, rows) {
  if (!rows.length) return '_No data in this range._'

  const head = `| ${headers.join(' | ')} |`
  const line = `| ${headers.map(() => '---').join(' | ')} |`
  const body = rows.map(
    (row) =>
      `| ${row
        .map((value) =>
          String(value ?? '')
            .replaceAll('|', '\\|')
            .replaceAll('\n', ' ')
        )
        .join(' | ')} |`
  )

  return [head, line, ...body].join('\n')
}

function summaryMarkdown(range, history, incidents, stats) {
  const totals = history?.totals || {}
  const coverage = history?.coverage || {}

  const providerTable = markdownTable(
    ['Provider', 'Requests', 'Usage', 'Errors'],
    stats.providers.map((item) => [
      item.key,
      item.requests,
      formatBytes(item.bytes),
      item.errors,
    ])
  )

  const featureTable = markdownTable(
    ['Feature', 'Requests', 'Usage', 'Errors'],
    stats.features.map((item) => [
      item.key,
      item.requests,
      formatBytes(item.bytes),
      item.errors,
    ])
  )

  const routeTable = markdownTable(
    ['Route', 'HTTP', 'Supabase', 'DB/HTTP', 'External', 'Errors', 'Diagnostic', 'Top target'],
    (stats.routes || []).map((item) => [
      item.route, item.http_requests, item.supabase_calls,
      item.supabase_per_http ?? '-', item.external_calls,
      item.errors, item.diagnostic, item.top_target || '-',
    ])
  )

  const targetTable = markdownTable(
    ['Route', 'Target', 'Calls', 'Errors', 'Avg ms', 'DB/HTTP'],
    (stats.route_targets || []).slice(0, 40).map((item) => [
      item.route, item.target, item.calls, item.errors,
      item.avg_ms, item.supabase_per_http ?? '-',
    ])
  )

  const requestEvidenceTable = markdownTable(
    ['Time', 'Route', 'Kind', 'HTTP', 'Supabase', 'Duration ms', 'Top request target'],
    (stats.recent_request_evidence || []).slice(0, 40).map((item) => [
      item.time, item.route, item.diagnostic_kind || '-',
      item.http_status, item.observed_supabase_calls ?? '-', item.duration_ms,
      item.targets?.[0] ? `${item.targets[0].target} ×${item.targets[0].count}` : '-',
    ])
  )

  const errorTable = markdownTable(
    [
      'Priority',
      'Route',
      'HTTP',
      'Error Code',
      'Stage',
      'Provider',
      'Count',
      'Windows',
      'Last seen',
    ],
    (stats.error_diagnostics || []).map((item) => [
      item.priority,
      item.route,
      item.http_status,
      item.error_code,
      item.stage,
      item.provider,
      item.count,
      item.windows_seen,
      item.last_seen_at,
    ])
  )

  const errorActionsTable = markdownTable(
    ['Priority', 'Route', 'Observed signal', 'Recommended check'],
    (stats.error_diagnostics || []).filter((item) =>
      item.priority === 'urgent' || item.priority === 'high'
    ).slice(0, 20).map((item) => [
      item.priority, item.route, item.signal, item.next_check,
    ])
  )

  const fanoutTable = markdownTable(
    ['Route', 'HTTP', 'Supabase', 'DB/HTTP', 'Errors'],
    (stats.fanout_candidates || []).map((item) => [
      item.route, item.http_requests, item.supabase_calls,
      item.supabase_per_http, item.errors,
    ])
  )

  const summary = stats.usage_summary || {}
  const usageTotals = summary.totals || {}
  const summaryRows = Array.isArray(summary.rows) ? summary.rows : []
  const breakdownTable = markdownTable(
    ['Kind', 'Feature', 'Dependency', 'Observed events', 'Usage', 'Errors'],
    summaryRows.map((row) => [
      row.kind, row.feature, row.dependency,
      safeNumber(row.count), formatBytes(row.bytes), safeNumber(row.errors),
    ])
  )

  return [
    '# Shadow System Control — Summary Report',
    '',
    `Generated: ${new Date().toISOString()}`,
    `Range: ${range.from} → ${range.to}`,
    `Requested end: ${range.requested_to}`,
    '',
    '## Usage',
    '',
    `- Total data: ${formatBytes(totals.bytes)}`,
    `- Measured events (HTTP + external calls, not Render billable requests): ${safeNumber(totals.requests).toLocaleString('en-US')}`,
    `- HTTP responses observed: ${safeNumber(usageTotals.http_responses_observed).toLocaleString('en-US')}`,
    `- External calls observed: ${safeNumber(usageTotals.external_calls_observed).toLocaleString('en-US')}`,
    `- Supabase calls observed: ${safeNumber(usageTotals.supabase_calls_observed).toLocaleString('en-US')}`,
    `- Unclassified events: ${safeNumber(usageTotals.unclassified_events).toLocaleString('en-US')}`,
    `- Summary details complete: ${summary.complete_detail === true ? 'Yes' : 'No'}`,
    `- Legacy windows: ${safeNumber(summary.legacy_windows)}`,
    `- Series granularity: ${coverage.series_granularity || 'original'}`,
    `- Errors: ${safeNumber(totals.errors).toLocaleString('en-US')}`,
    `- Partial coverage: ${coverage.partial === true ? 'Yes' : 'No'}`,
    `- Stored snapshots: ${safeNumber(coverage.stored_snapshots)}`,
    `- Archived rollups: ${safeNumber(coverage.archived_rollups)}`,
    `- Live minutes: ${safeNumber(coverage.live_minutes)}`,
    `- Coverage gaps: ${safeNumber(coverage.gap_count)}; missing minutes: ${safeNumber(coverage.missing_minutes)}`,
    `- Available range: ${coverage.available_from || 'unknown'} → ${coverage.available_to || 'unknown'}`,
    '',
    '## Observed Dependency Summary',
    '',
    breakdownTable,
    '',
    stats.detail_note,
    '',
    '## Incidents',
    '',
    `- Total: ${stats.incidents.total}`,
    `- Verified: ${stats.incidents.verified}`,
    `- Resolved: ${stats.incidents.resolved}`,
    `- Critical: ${stats.incidents.critical}`,
    '',
    '## Diagnostic Meaning',
    '',
    stats.diagnostics_note,
    '',
    '## Top Providers',
    '',
    providerTable,
    '',
    '## Top Features',
    '',
    featureTable,
    '',
    '## Route Diagnostics (bounded detail)',
    '',
    routeTable,
    '',
    '## Route Target Breakdown (bounded detail)',
    '',
    targetTable,
    '',
    '## Error Diagnostics (stored 15-minute evidence and live memory)',
    '',
    'Errors are prioritized for investigation and grouped by route and error signature across available time windows.',
    '',
    `Evidence coverage: ${stats.error_diagnostics_coverage ? safeNumber(stats.error_diagnostics_coverage.stored_windows_with_error_field) : 'unknown'} stored windows with evidence; ${stats.error_diagnostics_coverage ? safeNumber(stats.error_diagnostics_coverage.stored_windows_without_error_field) : 'unknown'} without evidence; ${safeNumber(stats.error_diagnostics_summary?.available_groups)} available groups; ${safeNumber(stats.error_diagnostics_summary?.displayed_groups)} shown.`,
    `High-priority groups shown: ${safeNumber(stats.error_diagnostics_summary?.high_priority_groups_displayed)}; unknown diagnostic stages shown: ${safeNumber(stats.error_diagnostics_summary?.unknown_stage_groups_displayed)}; details capped: ${stats.error_diagnostics_summary?.capped ? 'Yes' : 'No'}.`,
    '',
    'Counts are bounded diagnostic observations, not complete error totals. A suggested cause or check is an inference, not proof. Older snapshots without evidence cannot be reconstructed.',
    '',
    errorTable,
    '',
    '## High-priority Error Investigation',
    '',
    errorActionsTable,
    '',
    '## Elevated Database Fanout (not proof of a loop)',
    '',
    fanoutTable,
    '',
    '## Recent Per-Request Evidence (in memory only)',
    '',
    requestEvidenceTable,
    '',
  ].join('\n')
}

function problemsMarkdown(range, incidents, stats = {}) {
  const table = markdownTable(
    [
      'ID',
      'Severity',
      'Status',
      'Feature',
      'Route',
      'Provider',
      'First Seen',
      'Last Seen',
      'Recurrence',
    ],
    incidents.map((item) => [
      item.id,
      item.severity,
      item.status,
      item.feature,
      item.source_route,
      item.dependency,
      item.first_seen_at,
      item.last_seen_at,
      item.recurrence_count,
    ])
  )

  const errorSignals = markdownTable(
    ['Priority', 'Route', 'HTTP', 'Error Code', 'Provider', 'Provider HTTP', 'Count', 'Signal', 'Next Check'],
    (stats.error_diagnostics || []).filter((item) =>
      item.priority === 'urgent' || item.priority === 'high' || item.priority === 'medium'
    ).slice(0, 40).map((item) => [
      item.priority, item.route, item.http_status, item.error_code,
      item.provider, item.provider_http_status, item.count, item.signal, item.next_check,
    ])
  )

  const fanoutSignals = markdownTable(
    ['Route', 'HTTP', 'Supabase', 'DB/HTTP', 'Errors'],
    (stats.fanout_candidates || []).map((item) => [
      item.route, item.http_requests, item.supabase_calls,
      item.supabase_per_http, item.errors,
    ])
  )

  return [
    '# Shadow System Control — Problems Report',
    '',
    `Generated: ${new Date().toISOString()}`,
    `Range: ${range.from} → ${range.to}`,
    '',
    '## Prioritized Error Evidence',
    '',
    'Derived from available stored diagnostics; possible explanations are not verified root causes.',
    '',
    errorSignals,
    '',
    '## Database Fanout Candidates',
    '',
    'High DB/HTTP is not by itself evidence of polling or a loop. Missing bounded route details can hide candidates.',
    '',
    fanoutSignals,
    '',
    `Unclassified measured events: ${stats.usage_summary?.totals?.unclassified_events == null ? 'unknown' : safeNumber(stats.usage_summary.totals.unclassified_events)}. These cannot be safely assigned to a specific route without additional evidence.`,
    '',
    '## Recorded Incidents',
    '',
    table,
    '',
  ].join('\n')
}

function usageCsv(history) {
  const header = [
    'started_at',
    'ended_at',
    'source',
    'requests',
    'bytes',
    'mb',
    'errors',
  ]

  const rows = Array.isArray(history?.series) ? history.series : []

  return [
    header.map(csvCell).join(','),
    ...rows.map((row) =>
      [
        row.started_at,
        row.ended_at,
        row.source,
        safeNumber(row.count),
        safeNumber(row.bytes),
        safeNumber(row.mb),
        safeNumber(row.errors),
      ]
        .map(csvCell)
        .join(',')
    ),
  ].join('\n')
}

function breakdownCsv(history) {
  const rows = Array.isArray(history?.usage_summary?.rows) ? history.usage_summary.rows : []
  const header = ['kind', 'feature', 'dependency', 'observed_events', 'bytes', 'errors']
  return [
    header.map(csvCell).join(','),
    ...rows.map((row) => [row.kind, row.feature, row.dependency,
      safeNumber(row.count), safeNumber(row.bytes), safeNumber(row.errors)]
      .map(csvCell).join(',')),
  ].join('\n')
}

function evidenceJson(range, history, incidents, stats) {
  return JSON.stringify(
    {
      generated_at: new Date().toISOString(),
      range,
      diagnostic_semantics: {
        database_fanout: 'Many database calls per HTTP request do not prove an application loop.',
        live_evidence: 'Per-request evidence may be missing after a restart or expiry.',
        bounded_detail: 'Top routes and targets do not necessarily cover all observed requests.',
      },
      summary: stats,
      usage: history,
      incidents,
    },
    null,
    2
  )
}

function sanitizePdfText(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[^\x20-\x7E]/g, '?')
}

function wrapPdfLine(value, maxLength = 92) {
  const text = sanitizePdfText(value)
  if (!text) return ['']

  const words = text.split(/\s+/)
  const lines = []
  let current = ''

  for (const word of words) {
    if (!current) {
      current = word
      continue
    }

    if (`${current} ${word}`.length <= maxLength) {
      current += ` ${word}`
      continue
    }

    lines.push(current)
    current = word
  }

  if (current) lines.push(current)
  return lines
}

function markdownToPdfLines(markdown) {
  const lines = []

  for (const sourceLine of String(markdown || '').split('\n')) {
    const line = sourceLine
      .replace(/^#{1,6}\s+/, '')
      .replace(/\*\*/g, '')
      .replace(/`/g, '')
      .replace(/^\|\s*/, '')
      .replace(/\s*\|$/, '')
      .replace(/\s*\|\s*/g, ' | ')

    if (/^[-|:\s]+$/.test(line)) continue
    lines.push(...wrapPdfLine(line))
  }

  return lines
}

function escapePdf(value) {
  return String(value)
    .replaceAll('\\', '\\\\')
    .replaceAll('(', '\\(')
    .replaceAll(')', '\\)')
}

function createPdf(markdown) {
  const lines = markdownToPdfLines(markdown)
  const linesPerPage = 46
  const pages = []

  for (let index = 0; index < lines.length; index += linesPerPage) {
    pages.push(lines.slice(index, index + linesPerPage))
  }

  if (!pages.length) pages.push(['No data.'])

  const objects = []
  const pageObjectIds = []
  const contentObjectIds = []
  const fontObjectId = 3
  let nextId = 4

  for (let index = 0; index < pages.length; index += 1) {
    pageObjectIds.push(nextId)
    contentObjectIds.push(nextId + 1)
    nextId += 2
  }

  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>'
  objects[2] =
    `<< /Type /Pages /Kids [${pageObjectIds
      .map((id) => `${id} 0 R`)
      .join(' ')}] /Count ${pages.length} >>`
  objects[fontObjectId] =
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'

  pages.forEach((pageLines, pageIndex) => {
    const pageId = pageObjectIds[pageIndex]
    const contentId = contentObjectIds[pageIndex]
    const streamLines = [
      'BT',
      '/F1 9 Tf',
      '12 TL',
      '44 800 Td',
    ]

    pageLines.forEach((line, lineIndex) => {
      if (lineIndex > 0) streamLines.push('T*')
      streamLines.push(`(${escapePdf(line)}) Tj`)
    })

    streamLines.push('ET')
    const stream = streamLines.join('\n')

    objects[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 842] /Resources << /Font << /F1 ${fontObjectId} 0 R >> >> /Contents ${contentId} 0 R >>`

    objects[contentId] =
      `<< /Length ${Buffer.byteLength(stream, 'utf8')} >>\nstream\n${stream}\nendstream`
  })

  let pdf = '%PDF-1.4\n'
  const offsets = [0]

  for (let id = 1; id < objects.length; id += 1) {
    if (!objects[id]) continue
    offsets[id] = Buffer.byteLength(pdf, 'utf8')
    pdf += `${id} 0 obj\n${objects[id]}\nendobj\n`
  }

  const xrefOffset = Buffer.byteLength(pdf, 'utf8')
  const maxId = objects.length - 1

  pdf += `xref\n0 ${maxId + 1}\n`
  pdf += '0000000000 65535 f \n'

  for (let id = 1; id <= maxId; id += 1) {
    const offset = offsets[id] || 0
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`
  }

  pdf +=
    `trailer\n<< /Size ${maxId + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`

  return Buffer.from(pdf, 'utf8')
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)

  for (let index = 0; index < 256; index += 1) {
    let crc = index

    for (let bit = 0; bit < 8; bit += 1) {
      crc =
        crc & 1
          ? 0xEDB88320 ^ (crc >>> 1)
          : crc >>> 1
    }

    table[index] = crc >>> 0
  }

  return table
})()

function crc32(buffer) {
  let crc = 0xFFFFFFFF

  for (let index = 0; index < buffer.length; index += 1) {
    crc =
      CRC_TABLE[(crc ^ buffer[index]) & 0xFF] ^
      (crc >>> 8)
  }

  return (crc ^ 0xFFFFFFFF) >>> 0
}

function dosDateTime(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value)
  const year = Math.max(1980, date.getUTCFullYear())

  const time =
    (date.getUTCHours() << 11) |
    (date.getUTCMinutes() << 5) |
    Math.floor(date.getUTCSeconds() / 2)

  const day =
    ((year - 1980) << 9) |
    ((date.getUTCMonth() + 1) << 5) |
    date.getUTCDate()

  return { time, date: day }
}

function createZip(entries) {
  const locals = []
  const centrals = []
  let offset = 0
  const now = dosDateTime(new Date())

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const data = Buffer.isBuffer(entry.data)
      ? entry.data
      : Buffer.from(String(entry.data ?? ''), 'utf8')
    const crc = crc32(data)

    const local = Buffer.alloc(30 + name.length)
    local.writeUInt32LE(0x04034B50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt16LE(now.time, 10)
    local.writeUInt16LE(now.date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    name.copy(local, 30)

    locals.push(local, data)

    const central = Buffer.alloc(46 + name.length)
    central.writeUInt32LE(0x02014B50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt16LE(now.time, 12)
    central.writeUInt16LE(now.date, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)
    name.copy(central, 46)

    centrals.push(central)
    offset += local.length + data.length
  }

  const centralDirectory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)

  end.writeUInt32LE(0x06054B50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralDirectory.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)

  return Buffer.concat([
    ...locals,
    centralDirectory,
    end,
  ])
}

async function buildReportBundle(from, to) {
  const range = normalizeRange(from, to)

  const [history, incidents] = await Promise.all([
    getSystemUsageHistory({
      from: range.from,
      to: range.to,
    }),
    loadIncidentsForRange(
      range.from,
      range.to
    ),
  ])

  const requestEvidence = filterRecentEvidence(range)

  const historicalErrorEntries =
    Array.isArray(history?.error_diagnostics)
      ? history.error_diagnostics
      : getHistoricalErrorEvidence({
          from: range.from,
          to: range.to,
        })

  const errorDiagnostics = buildActionableErrorDiagnostics(historicalErrorEntries, 60)
  const baseStats = buildSummaryStats(history, incidents, requestEvidence)
  const errorCoverage = history?.error_diagnostics_coverage || null

  const stats = {
    ...baseStats,
    error_diagnostics: errorDiagnostics,
    error_diagnostics_coverage: errorCoverage,
    error_diagnostics_summary: summarizeActionableErrorDiagnostics(
      errorDiagnostics, historicalErrorEntries, errorCoverage
    ),
    fanout_candidates: buildFanoutCandidates(baseStats.routes),
  }
  const summaryMd = summaryMarkdown(
    range,
    history,
    incidents,
    stats
  )
  const problemsMd = problemsMarkdown(range, incidents, stats)
  const csv = usageCsv(history)
  const json = evidenceJson(
    range,
    history,
    incidents,
    stats
  )

  return {
    range,
    summaryMd,
    problemsMd,
    csv,
    breakdownCsv: breakdownCsv(history),
    json,
  }
}

function reportName(prefix, range, extension) {
  return `${prefix}_${rangeSlug(
    range.from,
    range.to
  )}.${extension}`
}

async function buildDatabaseIoZipEntries(range) {
  let report = null
  let status = 'unavailable'
  let reason = 'Database IO evidence could not be prepared.'
  const from = Date.parse(range.from)
  const to = Date.parse(range.to)
  if (to - from > 30 * 24 * 60 * 60 * 1000) {
    status = 'unsupported_range'
    reason = 'Database IO download supports up to 30 days. The system report range was not shortened.'
  } else {
    try {
      const { buildDatabaseIoDownload } = await import('./databaseIoDownload.service.js')
      const { formatDatabaseIoReport } = await import('./databaseIoReportFormat.service.js')
      report = await buildDatabaseIoDownload({ from, to })
      if (report) {
        const covered = Number(report.coverage?.covered_seconds || 0)
        const incomplete = Number(report.coverage?.uncovered_seconds || 0) > 0 || Number(report.coverage?.partial_intervals || 0) > 0 || Number(report.coverage?.detail_available || 0) < Number(report.coverage?.detail_selected || 0)
        status = covered <= 0 ? 'no_covered_intervals' : incomplete ? 'partial' : 'available'
        return [
          { name: 'DatabaseIO.md', data: `Export status: ${status}\n\n${formatDatabaseIoReport(report)}` },
          { name: 'DatabaseIO.json', data: JSON.stringify({ ...report, export_status: status }, null, 2) },
        ]
      }
      status = 'busy'
      reason = 'Another Database IO report is being prepared. Download again later.'
    } catch (error) {
      console.warn('SYSTEM_REPORT_DATABASE_IO_UNAVAILABLE', String(error?.code || error?.name || 'UNKNOWN').slice(0, 80))
    }
  }
  return [
    { name: 'DatabaseIO.md', data: `# Shadow Database IO Evidence Report\n\nExport status: ${status}\n\nUTC range: ${range.from} to ${range.to}\n\n${reason}\n\nUnavailable metrics are not zero.\n` },
    { name: 'DatabaseIO.json', data: JSON.stringify({ version: 1, mode: 'monitoring_only', export_status: status, range: { from: range.from, to: range.to }, reason, totals: null }, null, 2) },
  ]
}

export async function generateSystemUsageReport({
  type,
  from,
  to,
} = {}) {
  const kind = String(type || '').trim().toLowerCase()

  const supported = new Set([
    'summary-md',
    'summary-pdf',
    'usage-csv',
    'problems-md',
    'problems-pdf',
    'evidence-json',
    'full-zip',
  ])

  if (!supported.has(kind)) {
    throw new Error('Unsupported report type.')
  }

  const bundle = await buildReportBundle(from, to)

  if (kind === 'summary-md') {
    return {
      filename: reportName(
        'shadow-system-summary',
        bundle.range,
        'md'
      ),
      contentType: 'text/markdown; charset=utf-8',
      body: Buffer.from(bundle.summaryMd, 'utf8'),
    }
  }

  if (kind === 'summary-pdf') {
    return {
      filename: reportName(
        'shadow-system-summary',
        bundle.range,
        'pdf'
      ),
      contentType: 'application/pdf',
      body: createPdf(bundle.summaryMd),
    }
  }

  if (kind === 'usage-csv') {
    return {
      filename: reportName(
        'shadow-system-usage',
        bundle.range,
        'csv'
      ),
      contentType: 'text/csv; charset=utf-8',
      body: Buffer.from(bundle.csv, 'utf8'),
    }
  }

  if (kind === 'problems-md') {
    return {
      filename: reportName(
        'shadow-system-problems',
        bundle.range,
        'md'
      ),
      contentType: 'text/markdown; charset=utf-8',
      body: Buffer.from(bundle.problemsMd, 'utf8'),
    }
  }

  if (kind === 'problems-pdf') {
    return {
      filename: reportName(
        'shadow-system-problems',
        bundle.range,
        'pdf'
      ),
      contentType: 'application/pdf',
      body: createPdf(bundle.problemsMd),
    }
  }

  if (kind === 'evidence-json') {
    return {
      filename: reportName(
        'shadow-system-evidence',
        bundle.range,
        'json'
      ),
      contentType: 'application/json; charset=utf-8',
      body: Buffer.from(bundle.json, 'utf8'),
    }
  }

  const summaryPdf = createPdf(bundle.summaryMd)
  const problemsPdf = createPdf(bundle.problemsMd)
  const databaseIoEntries = await buildDatabaseIoZipEntries(bundle.range)

  return {
    filename: reportName(
      'shadow-system-full-report',
      bundle.range,
      'zip'
    ),
    contentType: 'application/zip',
    body: createZip([
      { name: 'Summary.md', data: bundle.summaryMd },
      { name: 'Summary.pdf', data: summaryPdf },
      { name: 'Usage.csv', data: bundle.csv },
      { name: 'Breakdown.csv', data: bundle.breakdownCsv },
      { name: 'Problems.md', data: bundle.problemsMd },
      { name: 'Problems.pdf', data: problemsPdf },
      { name: 'Evidence.json', data: bundle.json },
      ...databaseIoEntries,
    ]),
  }
}
