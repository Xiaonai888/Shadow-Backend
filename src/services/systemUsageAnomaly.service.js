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
const MIN_BYTES_DELTA = Math.max(
  256 * 1024,
  Number(process.env.SYSTEM_USAGE_MIN_BYTES_DELTA || 1024 * 1024)
)
const MIN_REQUEST_DELTA = Math.max(
  20,
  Number(process.env.SYSTEM_USAGE_MIN_REQUEST_DELTA || 100)
)
const ACTIVE_WINDOWS_REQUIRED = 2
const RECOVERY_WINDOWS_REQUIRED = 4

let timer = null
let lastAnalyzedEnd = 0

const state = {
  status: 'learning',
  suspicious_windows: 0,
  recovery_windows: 0,
  first_anomaly_at: null,
  last_analyzed_at: null,
  baseline: null,
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

  return { count, bytes, errors }
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

  const totals = source.reduce(
    (result, minute) => {
      const value = summarizeRows(minute.rows)
      result.count += value.count
      result.bytes += value.bytes
      result.errors += value.errors
      return result
    },
    { count: 0, bytes: 0, errors: 0 }
  )

  return {
    ready: true,
    available_minutes: source.length,
    required_minutes: MIN_BASELINE_MINUTES,
    count_15s: totals.count / source.length / 4,
    bytes_15s: totals.bytes / source.length / 4,
    errors_15s: totals.errors / source.length / 4,
  }
}

function topDriver(rows = []) {
  const row = rows
    .filter((item) => !isMonitorRow(item))
    .sort(
      (a, b) =>
        Number(b.bytes || 0) - Number(a.bytes || 0) ||
        Number(b.count || 0) - Number(a.count || 0)
    )[0]

  if (!row) return null

  return {
    feature: row.feature || 'unknown',
    source_route: row.source_route || 'UNKNOWN',
    dependency: row.dependency || 'UNKNOWN',
    count: Number(row.count || 0),
    bytes: Number(row.bytes || 0),
    mb: Number((Number(row.bytes || 0) / 1024 / 1024).toFixed(4)),
    errors: Number(row.errors || 0),
  }
}

function analyzeCompletedWindow() {
  const snapshot = getSystemUsageSnapshot()
  const latest = snapshot.recent_live?.at(-1)

  if (!latest || Number(latest.ended_at) <= lastAnalyzedEnd) return

  lastAnalyzedEnd = Number(latest.ended_at)
  const baseline = buildBaseline(snapshot.recent_minutes || [])
  const current = summarizeRows(latest.rows || [])

  state.last_analyzed_at = Date.now()
  state.baseline = baseline
  state.current = {
    ...current,
    mb: Number((current.bytes / 1024 / 1024).toFixed(4)),
    window_start: latest.started_at,
    window_end: latest.ended_at,
  }
  state.top_driver = topDriver(latest.rows || [])

  if (!baseline.ready) {
    state.status = 'learning'
    state.suspicious_windows = 0
    state.recovery_windows = 0
    state.signals = []
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

  const signals = []

  if (current.bytes >= byteLimit) signals.push('bytes_spike')
  if (current.count >= requestLimit) signals.push('request_spike')

  state.signals = signals

  if (signals.length > 0) {
    state.suspicious_windows += 1
    state.recovery_windows = 0

    if (!state.first_anomaly_at) {
      state.first_anomaly_at = Date.now()
    }

    state.status =
      state.suspicious_windows >= ACTIVE_WINDOWS_REQUIRED
        ? 'active'
        : 'suspect'

    return
  }

  state.suspicious_windows = 0

  if (state.status === 'active' || state.status === 'recovery') {
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
      ratio_threshold: RATIO_THRESHOLD,
      min_bytes_delta: MIN_BYTES_DELTA,
      min_request_delta: MIN_REQUEST_DELTA,
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
