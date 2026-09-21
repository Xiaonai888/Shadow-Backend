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
        Number(b.bytes || 0) - Number(a.bytes || 0) ||
        Number(b.count || 0) - Number(a.count || 0)
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

function classify(driver, signals) {
  const route = String(driver?.source_route || '').toUpperCase()
  const dependency = String(driver?.dependency || '').toUpperCase()

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

  state.current = {
    ...current,
    http_requests_observed: httpRequestsObserved,
    external_calls_observed: externalCallsObserved,
    supabase_calls_observed: supabaseCallsObserved,
    route_breakdown: busiestRoutes,
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
  }

  const signals = []

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
