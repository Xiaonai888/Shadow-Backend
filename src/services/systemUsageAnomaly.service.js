import { getSystemUsageSnapshot } from './systemUsageMonitor.service.js'

const ANALYZE_MS = 15 * 1000
const MIN_BASELINE_MINUTES = Math.max(
  5,
  Number(process.env.SYSTEM_USAGE_BASELINE_MINUTES || 10)
)
const MAX_BASELINE_MINUTES = 30
const RATIO_THRESHOLD = Math.max(
  2,
  Number(process.env.SYSTEM_USAGE_ANOMALY_RATIO || 4)
)
const ERROR_RATIO_THRESHOLD = Math.max(
  2,
  Number(process.env.SYSTEM_USAGE_ERROR_RATIO || 4)
)
const MIN_BYTES_DELTA = Math.max(
  256 * 1024,
  Number(process.env.SYSTEM_USAGE_MIN_BYTES_DELTA || 1024 * 1024)
)
const MIN_REQUEST_DELTA = Math.max(
  20,
  Number(process.env.SYSTEM_USAGE_MIN_REQUEST_DELTA || 100)
)
const MIN_ERROR_DELTA = Math.max(
  3,
  Number(process.env.SYSTEM_USAGE_MIN_ERROR_DELTA || 5)
)
const HARD_BYTES_15S = Math.max(
  0,
  Number(process.env.SYSTEM_USAGE_HARD_BYTES_15S || 0)
)
const HARD_REQUESTS_15S = Math.max(
  0,
  Number(process.env.SYSTEM_USAGE_HARD_REQUESTS_15S || 0)
)
const ACTIVE_WINDOWS_REQUIRED = 2
const RECOVERY_WINDOWS_REQUIRED = 4
const ROUTE_BURST_RATIO = Math.max(
  3,
  Number(process.env.SYSTEM_USAGE_ROUTE_BURST_RATIO || 4)
)
const ROUTE_MIN_HTTP_15S = Math.max(
  5,
  Number(process.env.SYSTEM_USAGE_ROUTE_MIN_HTTP_15S || 10)
)
const ROUTE_MIN_SUPABASE_15S = Math.max(
  10,
  Number(process.env.SYSTEM_USAGE_ROUTE_MIN_SUPABASE_15S || 20)
)
const DB_FANOUT_RATIO = Math.max(
  5,
  Number(process.env.SYSTEM_USAGE_DB_FANOUT_RATIO || 8)
)

let timer = null
let lastAnalyzedEnd = 0

const state = {
  status: 'learning',
  severity: 'info',
  classification: 'learning',
  suspicious_windows: 0,
  recovery_windows: 0,
  first_anomaly_at: null,
  last_analyzed_at: null,
  baseline: null,
  thresholds: null,
  current: null,
  top_driver: null,
  signals: [],
}

function isMonitorRow(row) {
  return String(row?.source_path || '').startsWith(
    '/api/admin/system-control'
  )
}

function summarizeRows(rows = []) {
  let count = 0
  let bytes = 0
  let errors = 0

  for (const row of rows) {
    if (isMonitorRow(row)) continue

    count += Math.max(0, Number(row.count) || 0)
    bytes += Math.max(0, Number(row.bytes) || 0)
    errors += Math.max(0, Number(row.errors) || 0)
  }

  return {
    count,
    bytes,
    errors,
    error_rate: count > 0 ? errors / count : 0,
  }
}

function median(values = []) {
  const sorted = values
    .map((value) => Math.max(0, Number(value) || 0))
    .sort((a, b) => a - b)

  if (!sorted.length) return 0

  const middle = Math.floor(sorted.length / 2)

  if (sorted.length % 2 === 1) {
    return sorted[middle]
  }

  return (sorted[middle - 1] + sorted[middle]) / 2
}

function buildBaseline(minutes = []) {
  const source = minutes
    .filter((item) => Array.isArray(item?.rows))
    .slice(-MAX_BASELINE_MINUTES)

  if (source.length < MIN_BASELINE_MINUTES) {
    return {
      ready: false,
      available_minutes: source.length,
      required_minutes: MIN_BASELINE_MINUTES,
    }
  }

  const values = source.map((minute) =>
    summarizeRows(minute.rows)
  )

  const countPerMinute = values.map((value) => value.count)
  const bytesPerMinute = values.map((value) => value.bytes)
  const errorsPerMinute = values.map((value) => value.errors)

  return {
    ready: true,
    available_minutes: source.length,
    required_minutes: MIN_BASELINE_MINUTES,
    count_15s: median(countPerMinute) / 4,
    bytes_15s: median(bytesPerMinute) / 4,
    errors_15s: median(errorsPerMinute) / 4,
  }
}

function topDriver(rows = []) {
  const row = [...rows]
    .filter((item) => !isMonitorRow(item))
    .sort(
      (a, b) =>
        Number(b.count || 0) - Number(a.count || 0) ||
        Number(b.bytes || 0) - Number(a.bytes || 0)
    )[0]

  if (!row) return null

  return {
    kind: row.kind || 'unknown',
    feature: row.feature || 'unknown',
    source_route: row.source_route || 'UNKNOWN',
    source_method: row.source_method || 'UNKNOWN',
    source_path: row.source_path || 'UNKNOWN',
    dependency: row.dependency || 'UNKNOWN',
    operation_method: row.operation_method || 'UNKNOWN',
    target_path: row.target_path || 'UNKNOWN',
    count: Number(row.count || 0),
    bytes: Number(row.bytes || 0),
    mb: Number(
      (Number(row.bytes || 0) / 1024 / 1024).toFixed(4)
    ),
    errors: Number(row.errors || 0),
    avg_ms: Number(row.avg_ms || 0),
  }
}

function ratio(current, baseline) {
  const safeCurrent = Math.max(0, Number(current) || 0)
  const safeBaseline = Math.max(0, Number(baseline) || 0)

  if (safeBaseline <= 0) {
    return safeCurrent > 0 ? Number.POSITIVE_INFINITY : 1
  }

  return safeCurrent / safeBaseline
}

function routeTotals(rows = []) {
  const routes = new Map()

  for (const row of rows) {
    if (isMonitorRow(row)) continue

    const route = String(row.source_route || 'UNKNOWN')
    const amount = Math.max(0, Number(row.count) || 0)
    const current = routes.get(route) || {
      route,
      http_requests: 0,
      external_calls: 0,
      supabase_calls: 0,
      http_errors: 0,
      top_target: '',
      top_target_calls: 0,
    }

    if (row.kind === 'http_response') {
      current.http_requests += amount
      current.http_errors += Math.max(
        0,
        Number(row.errors) || 0
      )
    } else if (row.kind === 'external_request') {
      current.external_calls += amount

      if (
        String(row.dependency || '').toUpperCase() ===
        'SUPABASE'
      ) {
        current.supabase_calls += amount
      }

      if (amount > current.top_target_calls) {
        current.top_target_calls = amount
        current.top_target = [
          row.dependency,
          row.operation_method,
          row.target_path,
        ]
          .filter(Boolean)
          .join(' ')
      }
    }

    routes.set(route, current)
  }

  return routes
}

function roundedRatio(current, baseline) {
  const value = ratio(current, baseline)

  return Number.isFinite(value)
    ? Number(value.toFixed(2))
    : null
}

function buildRouteDiagnostics(
  liveRows = [],
  minuteWindows = []
) {
  const minutes = minuteWindows
    .filter((item) => Array.isArray(item?.rows))

  const latestMinute = minutes.at(-1) || null
  const baselineMinutes = minutes
    .slice(0, -1)
    .slice(-MAX_BASELINE_MINUTES)

  const baselineReady =
    baselineMinutes.length >= MIN_BASELINE_MINUTES

  const liveMap = routeTotals(liveRows)
  const minuteMap = routeTotals(
    latestMinute?.rows || []
  )
  const baselineMaps = baselineMinutes.map(
    (minute) => routeTotals(minute.rows || [])
  )

  const routeNames = new Set([
    ...liveMap.keys(),
    ...minuteMap.keys(),
  ])

  for (const map of baselineMaps) {
    for (const route of map.keys()) {
      routeNames.add(route)
    }
  }

  const diagnostics = []

  for (const route of routeNames) {
    const live = liveMap.get(route) || {}
    const minute = minuteMap.get(route) || {}

    const httpBaseline1m = median(
      baselineMaps.map(
        (map) => map.get(route)?.http_requests || 0
      )
    )
    const supabaseBaseline1m = median(
      baselineMaps.map(
        (map) => map.get(route)?.supabase_calls || 0
      )
    )

    const http15s = Math.max(
      0,
      Number(live.http_requests) || 0
    )
    const supabase15s = Math.max(
      0,
      Number(live.supabase_calls) || 0
    )
    const http1m = Math.max(
      0,
      Number(minute.http_requests) || 0
    )
    const supabase1m = Math.max(
      0,
      Number(minute.supabase_calls) || 0
    )

    const httpRatio15s = ratio(
      http15s,
      httpBaseline1m / 4
    )
    const supabaseRatio15s = ratio(
      supabase15s,
      supabaseBaseline1m / 4
    )
    const httpRatio1m = ratio(
      http1m,
      httpBaseline1m
    )
    const supabaseRatio1m = ratio(
      supabase1m,
      supabaseBaseline1m
    )

    const httpBurst15s =
      baselineReady &&
      http15s >= ROUTE_MIN_HTTP_15S &&
      httpRatio15s >= ROUTE_BURST_RATIO

    const supabaseBurst15s =
      baselineReady &&
      supabase15s >= ROUTE_MIN_SUPABASE_15S &&
      supabaseRatio15s >= ROUTE_BURST_RATIO

    const httpBurst1m =
      baselineReady &&
      http1m >= ROUTE_MIN_HTTP_15S * 4 &&
      httpRatio1m >= ROUTE_BURST_RATIO

    const supabaseBurst1m =
      baselineReady &&
      supabase1m >= ROUTE_MIN_SUPABASE_15S * 4 &&
      supabaseRatio1m >= ROUTE_BURST_RATIO

    const dbPerHttp15s =
      http15s > 0
        ? supabase15s / http15s
        : null

    const dbPerHttp1m =
      http1m > 0
        ? supabase1m / http1m
        : null

    const databaseFanout =
      (
        http15s >= 5 &&
        supabase15s >= ROUTE_MIN_SUPABASE_15S &&
        dbPerHttp15s >= DB_FANOUT_RATIO
      ) ||
      (
        http1m >= 20 &&
        supabase1m >= ROUTE_MIN_SUPABASE_15S * 4 &&
        dbPerHttp1m >= DB_FANOUT_RATIO
      )

    const persistentBurst =
      (httpBurst15s && httpBurst1m) ||
      (supabaseBurst15s && supabaseBurst1m)

    const flags = []

    if (httpBurst15s) flags.push('http_burst_15s')
    if (supabaseBurst15s) {
      flags.push('supabase_burst_15s')
    }
    if (httpBurst1m) flags.push('http_burst_1m')
    if (supabaseBurst1m) {
      flags.push('supabase_burst_1m')
    }
    if (databaseFanout) {
      flags.push('database_fanout')
    }
    if (persistentBurst) {
      flags.push('loop_or_polling_suspected')
    }

    diagnostics.push({
      route,
      baseline_ready: baselineReady,
      http_requests_15s: http15s,
      supabase_calls_15s: supabase15s,
      http_requests_1m: http1m,
      supabase_calls_1m: supabase1m,
      baseline_http_1m: httpBaseline1m,
      baseline_supabase_1m: supabaseBaseline1m,
      http_ratio_15s: roundedRatio(
        http15s,
        httpBaseline1m / 4
      ),
      supabase_ratio_15s: roundedRatio(
        supabase15s,
        supabaseBaseline1m / 4
      ),
      http_ratio_1m: roundedRatio(
        http1m,
        httpBaseline1m
      ),
      supabase_ratio_1m: roundedRatio(
        supabase1m,
        supabaseBaseline1m
      ),
      db_per_http_15s:
        dbPerHttp15s === null
          ? null
          : Number(dbPerHttp15s.toFixed(2)),
      db_per_http_1m:
        dbPerHttp1m === null
          ? null
          : Number(dbPerHttp1m.toFixed(2)),
      external_calls_15s:
        Math.max(
          0,
          Number(live.external_calls) || 0
        ),
      http_errors_15s:
        Math.max(
          0,
          Number(live.http_errors) || 0
        ),
      top_target:
        live.top_target ||
        minute.top_target ||
        '',
      flags,
      suspicious: flags.length > 0,
    })
  }

  return diagnostics.sort(
    (a, b) =>
      Number(b.suspicious) - Number(a.suspicious) ||
      b.supabase_calls_15s - a.supabase_calls_15s ||
      b.http_requests_15s - a.http_requests_15s ||
      b.supabase_calls_1m - a.supabase_calls_1m ||
      b.http_requests_1m - a.http_requests_1m
  )
}

function classify(driver, signals) {
  const route = String(driver?.source_route || '').toUpperCase()
  const dependency = String(driver?.dependency || '').toUpperCase()

  if (signals.includes('route_loop_suspected')) {
    return 'route_loop_suspected'
  }

  if (signals.includes('database_fanout')) {
    return 'database_fanout'
  }

  if (signals.includes('route_burst')) {
    return 'route_overload'
  }

  if (
    route.startsWith('WORKER ') ||
    route === 'BACKGROUND' ||
    driver?.source_method === 'WORKER'
  ) {
    return dependency === 'CLOUDFLARE_R2'
      ? 'background_egress'
      : 'background_job'
  }

  if (
    signals.includes('request_spike') &&
    dependency === 'CLIENT'
  ) {
    return 'route_overload'
  }

  if (
    signals.includes('bytes_spike') &&
    dependency !== 'CLIENT'
  ) {
    return 'dependency_egress'
  }

  if (signals.includes('error_spike')) {
    return 'error_burst'
  }

  return 'unknown'
}

function severityFor({
  signals,
  current,
  baseline,
  hardLimitTriggered,
}) {
  if (hardLimitTriggered) return 'critical'

  if (signals.includes('route_loop_suspected')) {
    return 'high'
  }

  if (
    signals.includes('database_fanout') &&
    signals.includes('route_burst')
  ) {
    return 'high'
  }

  const byteRatio = ratio(
    current.bytes,
    baseline.bytes_15s
  )
  const requestRatio = ratio(
    current.count,
    baseline.count_15s
  )
  const errorRatio = ratio(
    current.errors,
    baseline.errors_15s
  )

  const peakRatio = Math.max(
    Number.isFinite(byteRatio) ? byteRatio : RATIO_THRESHOLD * 2,
    Number.isFinite(requestRatio)
      ? requestRatio
      : RATIO_THRESHOLD * 2,
    Number.isFinite(errorRatio)
      ? errorRatio
      : ERROR_RATIO_THRESHOLD * 2
  )

  if (signals.length >= 2 || peakRatio >= RATIO_THRESHOLD * 2) {
    return 'high'
  }

  if (signals.length === 1) return 'medium'

  return 'info'
}

function resetLearningState() {
  state.status = 'learning'
  state.severity = 'info'
  state.classification = 'learning'
  state.suspicious_windows = 0
  state.recovery_windows = 0
  state.signals = []
  state.thresholds = null
}

function analyzeCompletedWindow() {
  const snapshot = getSystemUsageSnapshot()
  const latest = snapshot.recent_live?.at(-1)

  if (
    !latest ||
    Number(latest.ended_at) <= lastAnalyzedEnd
  ) {
    return
  }

  lastAnalyzedEnd = Number(latest.ended_at)

  const baseline = buildBaseline(
    snapshot.recent_minutes || []
  )
  const current = summarizeRows(latest.rows || [])
  const driver = topDriver(latest.rows || [])

  state.last_analyzed_at = Date.now()
  state.baseline = baseline
  const observedRows = latest.rows || []
  const routeCounts = new Map()
  let httpRequestsObserved = 0
  let externalCallsObserved = 0
  let supabaseCallsObserved = 0

  for (const row of observedRows) {
    if (isMonitorRow(row)) continue
    const amount = Math.max(0, Number(row.count) || 0)
    const route = String(row.source_route || 'UNKNOWN')
    const totals = routeCounts.get(route) || {
      route,
      http_requests: 0,
      supabase_calls: 0,
      http_errors: 0,
    }

    if (row.kind === 'http_response') {
      httpRequestsObserved += amount
      totals.http_requests += amount
      totals.http_errors += Math.max(0, Number(row.errors) || 0)
    } else if (row.kind === 'external_request') {
      externalCallsObserved += amount
      if (row.dependency === 'SUPABASE') {
        supabaseCallsObserved += amount
        totals.supabase_calls += amount
      }
    }
    routeCounts.set(route, totals)
  }

  const routes = [...routeCounts.values()].sort(
    (a, b) => b.supabase_calls - a.supabase_calls ||
      b.http_requests - a.http_requests
  )
  const busiestRoutes = routes.slice(0, 5)
  const driverRoute = routeCounts.get(driver?.source_route)
  if (driverRoute && !busiestRoutes.includes(driverRoute)) {
    busiestRoutes.push(driverRoute)
  }

  const routeDiagnostics = buildRouteDiagnostics(
    observedRows,
    snapshot.recent_minutes || []
  )

  state.current = {
    ...current,
    http_requests_observed: httpRequestsObserved,
    external_calls_observed: externalCallsObserved,
    supabase_calls_observed: supabaseCallsObserved,
    route_breakdown: busiestRoutes,
    route_diagnostics: routeDiagnostics.slice(0, 10),
    route_diagnostics_baseline_ready:
      routeDiagnostics.some(
        (item) => item.baseline_ready === true
      ),
    coverage: observedRows.length >= 100 ? 'top_100_rows_only' : 'recorded_rows',
    mb: Number((current.bytes / 1024 / 1024).toFixed(4)),
    error_rate_percent: Number((current.error_rate * 100).toFixed(2)),
    window_start: latest.started_at,
    window_end: latest.ended_at,
  }
  state.top_driver = driver

  if (!baseline.ready) {
    resetLearningState()
    return
  }

  const byteLimit = Math.max(
    baseline.bytes_15s * RATIO_THRESHOLD,
    baseline.bytes_15s + MIN_BYTES_DELTA
  )
  const requestLimit = Math.max(
    baseline.count_15s * RATIO_THRESHOLD,
    baseline.count_15s + MIN_REQUEST_DELTA
  )
  const errorLimit = Math.max(
    baseline.errors_15s * ERROR_RATIO_THRESHOLD,
    baseline.errors_15s + MIN_ERROR_DELTA
  )

  state.thresholds = {
    bytes_15s: byteLimit,
    requests_15s: requestLimit,
    errors_15s: errorLimit,
    hard_bytes_15s: HARD_BYTES_15S || null,
    hard_requests_15s: HARD_REQUESTS_15S || null,
    route_burst_ratio: ROUTE_BURST_RATIO,
    route_min_http_15s: ROUTE_MIN_HTTP_15S,
    route_min_supabase_15s:
      ROUTE_MIN_SUPABASE_15S,
    db_fanout_ratio: DB_FANOUT_RATIO,
  }

  const signals = []

  const loopRoute = routeDiagnostics.find(
    (item) =>
      item.flags.includes(
        'loop_or_polling_suspected'
      )
  )
  const burstRoute = routeDiagnostics.find(
    (item) =>
      item.flags.includes('http_burst_15s') ||
      item.flags.includes('supabase_burst_15s')
  )
  const fanoutRoute = routeDiagnostics.find(
    (item) =>
      item.flags.includes('database_fanout')
  )

  if (loopRoute) {
    signals.push('route_loop_suspected')
  } else if (burstRoute) {
    signals.push('route_burst')
  }

  if (fanoutRoute) {
    signals.push('database_fanout')
  }

  if (current.bytes >= byteLimit) {
    signals.push('bytes_spike')
  }

  if (current.count >= requestLimit) {
    signals.push('request_spike')
  }

  if (
    current.errors >= errorLimit &&
    current.error_rate >= 0.05
  ) {
    signals.push('error_spike')
  }

  const hardByteTriggered =
    HARD_BYTES_15S > 0 &&
    current.bytes >= HARD_BYTES_15S
  const hardRequestTriggered =
    HARD_REQUESTS_15S > 0 &&
    current.count >= HARD_REQUESTS_15S

  if (hardByteTriggered) {
    signals.push('hard_bytes_limit')
  }

  if (hardRequestTriggered) {
    signals.push('hard_request_limit')
  }

  const hardLimitTriggered =
    hardByteTriggered || hardRequestTriggered

  state.signals = [...new Set(signals)]
  state.classification = classify(
    driver,
    state.signals
  )
  state.severity = severityFor({
    signals: state.signals,
    current,
    baseline,
    hardLimitTriggered,
  })

  if (state.signals.length > 0) {
    state.suspicious_windows += 1
    state.recovery_windows = 0

    if (!state.first_anomaly_at) {
      state.first_anomaly_at = Date.now()
    }

    state.status =
      hardLimitTriggered ||
      state.suspicious_windows >= ACTIVE_WINDOWS_REQUIRED
        ? 'active'
        : 'suspect'

    return
  }

  state.suspicious_windows = 0
  state.severity = 'info'
  state.classification = 'normal'

  if (
    state.status === 'active' ||
    state.status === 'recovery'
  ) {
    state.recovery_windows += 1
    state.status =
      state.recovery_windows >= RECOVERY_WINDOWS_REQUIRED
        ? 'normal'
        : 'recovery'

    if (state.status === 'normal') {
      state.first_anomaly_at = null
      state.recovery_windows = 0
    }

    return
  }

  state.status = 'normal'
  state.recovery_windows = 0
  state.first_anomaly_at = null
}

export function getSystemUsageAnomalySnapshot() {
  return {
    ...state,
    config: {
      analyze_seconds: ANALYZE_MS / 1000,
      baseline_method: 'median',
      baseline_max_minutes: MAX_BASELINE_MINUTES,
      ratio_threshold: RATIO_THRESHOLD,
      error_ratio_threshold: ERROR_RATIO_THRESHOLD,
      min_bytes_delta: MIN_BYTES_DELTA,
      min_request_delta: MIN_REQUEST_DELTA,
      min_error_delta: MIN_ERROR_DELTA,
      hard_bytes_15s: HARD_BYTES_15S || null,
      hard_requests_15s: HARD_REQUESTS_15S || null,
      route_burst_ratio: ROUTE_BURST_RATIO,
      route_min_http_15s: ROUTE_MIN_HTTP_15S,
      route_min_supabase_15s:
        ROUTE_MIN_SUPABASE_15S,
      db_fanout_ratio: DB_FANOUT_RATIO,
      active_windows_required: ACTIVE_WINDOWS_REQUIRED,
      recovery_windows_required: RECOVERY_WINDOWS_REQUIRED,
    },
  }
}

export function startSystemUsageAnomalyDetector() {
  if (timer) return

  analyzeCompletedWindow()

  timer = setInterval(
    analyzeCompletedWindow,
    ANALYZE_MS
  )

  timer.unref?.()
}
