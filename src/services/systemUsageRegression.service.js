import {
  getSystemUsageHistory,
} from './systemUsagePersistence.service.js'
import {
  getSystemUsageSnapshot,
} from './systemUsageMonitor.service.js'

const ANALYZE_MS = Math.max(
  60 * 1000,
  Number(
    process.env.SYSTEM_USAGE_REGRESSION_ANALYZE_MS ||
      60 * 1000
  )
)

const BASELINE_HOURS = Math.max(
  6,
  Math.min(
    72,
    Number(
      process.env.SYSTEM_USAGE_REGRESSION_BASELINE_HOURS ||
        24
    )
  )
)

const CURRENT_MINUTES = Math.max(
  5,
  Math.min(
    30,
    Number(
      process.env.SYSTEM_USAGE_REGRESSION_CURRENT_MINUTES ||
        15
    )
  )
)

const MIN_HTTP = Math.max(
  5,
  Number(
    process.env.SYSTEM_USAGE_REGRESSION_MIN_HTTP ||
      20
  )
)

const RATIO = Math.max(
  1.2,
  Number(
    process.env.SYSTEM_USAGE_REGRESSION_RATIO ||
      1.5
  )
)

const WINDOWS_REQUIRED = Math.max(
  2,
  Number(
    process.env.SYSTEM_USAGE_REGRESSION_WINDOWS_REQUIRED ||
      2
  )
)

const DB_DELTA = Math.max(
  1,
  Number(
    process.env.SYSTEM_USAGE_REGRESSION_DB_DELTA ||
      2
  )
)

const BYTES_DELTA = Math.max(
  16 * 1024,
  Number(
    process.env.SYSTEM_USAGE_REGRESSION_BYTES_DELTA ||
      64 * 1024
  )
)

const LATENCY_DELTA_MS = Math.max(
  50,
  Number(
    process.env.SYSTEM_USAGE_REGRESSION_LATENCY_DELTA_MS ||
      250
  )
)

let timer = null
let running = false
let baselineLoading = false
let baselineLoadedAt = 0
let baselineRoutes = new Map()
const streaks = new Map()

const state = {
  status: 'learning',
  deploy_sha:
    String(
      process.env.RENDER_GIT_COMMIT ||
        process.env.GIT_COMMIT_SHA ||
        process.env.COMMIT_SHA ||
        ''
    ).trim() || null,
  baseline_hours: BASELINE_HOURS,
  current_minutes: CURRENT_MINUTES,
  baseline_loaded_at: null,
  last_analyzed_at: null,
  routes_compared: 0,
  regressions: [],
  improvements: [],
  read_policy:
    'one history read on startup, then in-memory only',
}

function safeNumber(value) {
  const number = Number(value)
  return Number.isFinite(number)
    ? Math.max(0, number)
    : 0
}

function routeMapFromRows(rows = []) {
  const routes = new Map()

  for (const row of rows || []) {
    const route = String(
      row?.source_route || 'UNKNOWN'
    )

    if (
      !route ||
      route === 'UNKNOWN' ||
      route.includes(
        '/api/admin/system-control'
      )
    ) {
      continue
    }

    const current = routes.get(route) || {
      route,
      http_requests: 0,
      supabase_calls: 0,
      bytes: 0,
      http_errors: 0,
      weighted_http_ms: 0,
    }

    const count = safeNumber(row?.count)
    current.bytes += safeNumber(row?.bytes)

    if (row?.kind === 'http_response') {
      current.http_requests += count
      current.http_errors +=
        safeNumber(row?.errors)
      current.weighted_http_ms +=
        safeNumber(row?.avg_ms) * count
    }

    if (
      row?.kind === 'external_request' &&
      String(
        row?.dependency || ''
      ).toUpperCase() === 'SUPABASE'
    ) {
      current.supabase_calls += count
    }

    routes.set(route, current)
  }

  return routes
}

function mergeRouteMaps(target, source) {
  for (const item of source.values()) {
    const current =
      target.get(item.route) || {
        route: item.route,
        http_requests: 0,
        supabase_calls: 0,
        bytes: 0,
        http_errors: 0,
        weighted_http_ms: 0,
      }

    current.http_requests +=
      item.http_requests
    current.supabase_calls +=
      item.supabase_calls
    current.bytes += item.bytes
    current.http_errors +=
      item.http_errors
    current.weighted_http_ms +=
      item.weighted_http_ms

    target.set(item.route, current)
  }

  return target
}

function finalize(item) {
  const http = safeNumber(
    item?.http_requests
  )

  return {
    route: item?.route || 'UNKNOWN',
    http_requests: http,
    supabase_calls:
      safeNumber(item?.supabase_calls),
    db_per_http:
      http > 0
        ? Number(
            (
              safeNumber(
                item?.supabase_calls
              ) / http
            ).toFixed(2)
          )
        : null,
    bytes_per_http:
      http > 0
        ? Math.round(
            safeNumber(item?.bytes) /
              http
          )
        : null,
    error_rate:
      http > 0
        ? Number(
            (
              safeNumber(
                item?.http_errors
              ) / http
            ).toFixed(4)
          )
        : 0,
    avg_ms:
      http > 0
        ? Number(
            (
              safeNumber(
                item?.weighted_http_ms
              ) / http
            ).toFixed(1)
          )
        : 0,
  }
}

function currentRouteMap() {
  const snapshot =
    getSystemUsageSnapshot()
  const cutoff =
    Date.now() -
    CURRENT_MINUTES * 60 * 1000

  const minutes = (
    snapshot.recent_minutes || []
  ).filter(
    (minute) =>
      safeNumber(minute?.started_at) >=
      cutoff
  )

  const routes = new Map()

  for (const minute of minutes) {
    mergeRouteMaps(
      routes,
      routeMapFromRows(
        minute?.rows || []
      )
    )
  }

  return routes
}

function changeRatio(current, baseline) {
  const a = safeNumber(current)
  const b = safeNumber(baseline)

  if (b <= 0) {
    return a > 0 ? null : 1
  }

  return Number((a / b).toFixed(2))
}

function signalFor(
  current,
  baseline
) {
  const signals = []

  if (
    current.db_per_http !== null &&
    baseline.db_per_http !== null &&
    current.db_per_http >=
      Math.max(
        baseline.db_per_http * RATIO,
        baseline.db_per_http +
          DB_DELTA
      )
  ) {
    signals.push('db_per_http')
  }

  if (
    current.bytes_per_http !== null &&
    baseline.bytes_per_http !== null &&
    current.bytes_per_http >=
      Math.max(
        baseline.bytes_per_http *
          RATIO,
        baseline.bytes_per_http +
          BYTES_DELTA
      )
  ) {
    signals.push('bytes_per_http')
  }

  if (
    current.error_rate >=
      Math.max(
        0.05,
        baseline.error_rate * 2
      ) &&
    current.error_rate >
      baseline.error_rate
  ) {
    signals.push('error_rate')
  }

  if (
    current.avg_ms >=
      Math.max(
        baseline.avg_ms * RATIO,
        baseline.avg_ms +
          LATENCY_DELTA_MS
      )
  ) {
    signals.push('avg_ms')
  }

  return signals
}

function improvementFor(
  current,
  baseline
) {
  const improved = []

  if (
    current.db_per_http !== null &&
    baseline.db_per_http !== null &&
    baseline.db_per_http > 0 &&
    current.db_per_http <=
      baseline.db_per_http * 0.8
  ) {
    improved.push('db_per_http')
  }

  if (
    current.bytes_per_http !== null &&
    baseline.bytes_per_http !== null &&
    baseline.bytes_per_http > 0 &&
    current.bytes_per_http <=
      baseline.bytes_per_http * 0.8
  ) {
    improved.push('bytes_per_http')
  }

  if (
    baseline.avg_ms > 0 &&
    current.avg_ms <=
      baseline.avg_ms * 0.8
  ) {
    improved.push('avg_ms')
  }

  return improved
}

function publicComparison(
  current,
  baseline,
  signals = []
) {
  return {
    route: current.route,
    signals,
    current,
    baseline,
    change: {
      db_per_http:
        changeRatio(
          current.db_per_http,
          baseline.db_per_http
        ),
      bytes_per_http:
        changeRatio(
          current.bytes_per_http,
          baseline.bytes_per_http
        ),
      error_rate:
        changeRatio(
          current.error_rate,
          baseline.error_rate
        ),
      avg_ms:
        changeRatio(
          current.avg_ms,
          baseline.avg_ms
        ),
    },
  }
}

async function loadBaseline() {
  if (baselineLoading) return
  baselineLoading = true

  try {
    const to = new Date()
    const from = new Date(
      to.getTime() -
        BASELINE_HOURS *
          60 *
          60 *
          1000
    )

    const history =
      await getSystemUsageHistory({
        from: from.toISOString(),
        to: to.toISOString(),
      })

    baselineRoutes =
      routeMapFromRows(
        history?.rows || []
      )

    baselineLoadedAt = Date.now()
    state.baseline_loaded_at =
      new Date(
        baselineLoadedAt
      ).toISOString()

    state.status =
      baselineRoutes.size > 0
        ? 'ready'
        : 'learning'
  } catch (error) {
    state.status = 'learning'
    console.error(
      'SYSTEM_USAGE_REGRESSION_BASELINE_ERROR:',
      error
    )
  } finally {
    baselineLoading = false
  }
}

function analyze() {
  if (!baselineRoutes.size) return

  const currentRoutes =
    currentRouteMap()

  const regressions = []
  const improvements = []
  let compared = 0

  for (
    const [
      route,
      rawCurrent,
    ] of currentRoutes
  ) {
    const rawBaseline =
      baselineRoutes.get(route)

    if (!rawBaseline) continue

    const current =
      finalize(rawCurrent)
    const baseline =
      finalize(rawBaseline)

    if (
      current.http_requests <
        MIN_HTTP ||
      baseline.http_requests <
        MIN_HTTP
    ) {
      continue
    }

    compared += 1

    const signals = signalFor(
      current,
      baseline
    )

    if (signals.length) {
      const next =
        safeNumber(
          streaks.get(route)
        ) + 1

      streaks.set(route, next)

      if (
        next >=
        WINDOWS_REQUIRED
      ) {
        regressions.push(
          publicComparison(
            current,
            baseline,
            signals
          )
        )
      }
    } else {
      streaks.delete(route)

      const improved =
        improvementFor(
          current,
          baseline
        )

      if (improved.length) {
        improvements.push(
          publicComparison(
            current,
            baseline,
            improved
          )
        )
      }
    }
  }

  for (
    const route of streaks.keys()
  ) {
    if (!currentRoutes.has(route)) {
      streaks.delete(route)
    }
  }

  regressions.sort(
    (a, b) =>
      b.signals.length -
        a.signals.length ||
      safeNumber(
        b.current.db_per_http
      ) -
        safeNumber(
          a.current.db_per_http
        )
  )

  improvements.sort(
    (a, b) =>
      safeNumber(
        a.change.db_per_http
      ) -
        safeNumber(
          b.change.db_per_http
        )
  )

  state.last_analyzed_at =
    new Date().toISOString()
  state.routes_compared = compared
  state.regressions =
    regressions.slice(0, 20)
  state.improvements =
    improvements.slice(0, 20)

  state.status =
    regressions.length > 0
      ? 'regression_detected'
      : 'healthy'
}

async function run() {
  if (running) return
  running = true

  try {
    if (!baselineRoutes.size) {
      await loadBaseline()
    }

    analyze()
  } catch (error) {
    console.error(
      'SYSTEM_USAGE_REGRESSION_ERROR:',
      error
    )
  } finally {
    running = false
  }
}

export function getSystemUsageRegressionState() {
  return JSON.parse(
    JSON.stringify(state)
  )
}

export function startSystemUsageRegressionWatch() {
  if (timer) return

  void run()

  timer = setInterval(
    run,
    ANALYZE_MS
  )

  timer.unref?.()
}
