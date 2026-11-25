const MAX_CONTEXTS = 8
const MAX_INSPECTABLES = 48
const MAX_METRICS = 16
const MAX_RUNNING = 12
const MAX_EVENTS = 16
const MAX_ROUTES = 12
const COUNT_FIELDS = /(?:^|_)(?:count|counts|entries|size|rows|pending|active|total|cached|expired|listeners|connections|timers|jobs|requests|bytes|mb|generation|seconds|in_flight)(?:_|$)/i

function label(value, max = 96) {
  return String(value ?? '').replace(/[^a-zA-Z0-9_ .:/-]/g, '_').slice(0, max)
}

function number(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function boundedArray(value, limit) {
  return Array.isArray(value) ? value.slice(0, limit) : []
}

function scalarMetrics(row) {
  const result = Object.create(null)
  for (const [key, value] of Object.entries(row || {})) {
    if (!COUNT_FIELDS.test(key) || !/^[a-zA-Z0-9_]{1,64}$/.test(key)) continue
    if (typeof value === 'boolean' || number(value) !== null) result[key] = value
    if (Object.keys(result).length >= MAX_METRICS) break
  }
  return result
}

function inspectableRows(rows, previous) {
  const old = new Map((previous || []).map(row => [row.name, row]))
  return boundedArray(rows, MAX_INSPECTABLES).map(row => {
    const name = label(row?.name, 120)
    const metrics = scalarMetrics(row)
    const prior = old.get(name)
    const delta = Object.create(null)
    if (prior) {
      for (const [key, value] of Object.entries(metrics)) {
        const before = prior.metrics[key]
        if (number(value) !== null && number(before) !== null && value !== before) {
          delta[key] = Math.round((value - before) * 10) / 10
        }
      }
    }
    return {
      name,
      mode: label(row?.mode, 40),
      state: label(row?.state, 40),
      metrics,
      delta_since_previous_context: delta,
    }
  })
}

function resourceCounts(value) {
  const result = Object.create(null)
  for (const [key, count] of Object.entries(value || {})) {
    if (number(count) !== null && count >= 0) result[label(key, 64)] = count
    if (Object.keys(result).length >= 24) break
  }
  return result
}

function jobRows(rows, limit) {
  return boundedArray(rows, limit).map(row => ({
    job_type: label(row?.jobType, 64),
    lane: label(row?.lane, 40),
    state: label(row?.state || row?.event, 40),
    started_at_ms: number(row?.startedAt),
    event_at_ms: number(row?.at),
    duration_ms: number(row?.durationMs),
  }))
}

function routeRows(rows) {
  return boundedArray(rows, MAX_ROUTES).map(row => ({
    route: label(row?.route, 120),
    count: number(row?.count),
    oldest_age_ms: number(row?.oldest_age_ms),
  }))
}

export function createRuntimeMemoryEvidenceTracker() {
  const contexts = []
  let sequence = 0

  function capture({ reason = 'unknown', runtime, telemetry, activeRoutes, activeRequestCount, now = Date.now() } = {}) {
    if (!runtime || typeof runtime !== 'object') return null
    const time = number(now) ?? Date.now()
    const prior = contexts.at(-1)
    const inspectables = Array.isArray(runtime.inspectables) ? runtime.inspectables : []
    const running = Array.isArray(telemetry?.running) ? telemetry.running : []
    const events = Array.isArray(telemetry?.events) ? telemetry.events : []
    const routes = Array.isArray(activeRoutes) ? activeRoutes : []
    const context = {
      sequence: ++sequence,
      pid: process.pid,
      captured_at: new Date(time).toISOString(),
      time_ms: time,
      reason: label(reason, 120),
      evidence_semantics: 'registered_sources_and_process_correlation_not_cause_proof',
      previous_context_age_ms: prior ? Math.max(0, time - prior.time_ms) : null,
      pressure: label(runtime.pressure, 40),
      process: {
        rss_mb: number(runtime.process?.rss_mb),
        heap_used_mb: number(runtime.process?.heap_used_mb),
        heap_total_mb: number(runtime.process?.heap_total_mb),
        external_mb: number(runtime.process?.external_mb),
        array_buffers_mb: number(runtime.process?.array_buffers_mb),
        non_heap_rss_estimate_mb: number(runtime.process?.non_heap_rss_estimate_mb),
        active_resource_total: number(runtime.process?.active_resource_total),
        active_resource_counts: resourceCounts(runtime.process?.active_resource_counts),
      },
      container: {
        guard_total_mb: number(runtime.container?.total_mb),
        current_mb: number(runtime.container?.cgroup_breakdown?.currentMb),
        limit_mb: number(runtime.container?.limit_mb),
        anonymous_mb: number(runtime.container?.cgroup_breakdown?.anonymousMb),
      },
      inspectables: inspectableRows(inspectables, prior?.inspectables),
      inspectables_registered: inspectables.length,
      inspectables_truncated: inspectables.length > MAX_INSPECTABLES,
      tracked_jobs: {
        available: Boolean(telemetry),
        running_count: number(telemetry?.runningCount),
        running: jobRows(running, MAX_RUNNING),
        recent_events: jobRows(events.slice(-MAX_EVENTS), MAX_EVENTS),
        coverage: 'resource_controller_instrumented_jobs_only',
      },
      requests: {
        active_count: number(activeRequestCount),
        routes: routeRows(routes),
        routes_truncated: routes.length > MAX_ROUTES,
      },
    }
    contexts.push(context)
    if (contexts.length > MAX_CONTEXTS) contexts.shift()
    return context
  }

  function snapshot({ limit = MAX_CONTEXTS } = {}) {
    const requested = Number(limit)
    const count = Number.isFinite(requested) ? Math.max(1, Math.min(MAX_CONTEXTS, Math.floor(requested))) : MAX_CONTEXTS
    return {
      pid: process.pid,
      persistent: false,
      capture_count: sequence,
      retained_contexts: contexts.length,
      latest: contexts.at(-1) ?? null,
      history: contexts.slice(-count),
    }
  }

  return { capture, snapshot }
}

const tracker = createRuntimeMemoryEvidenceTracker()

export const captureRuntimeMemoryEvidence = tracker.capture
export const getRuntimeMemoryEvidenceSnapshot = tracker.snapshot
