const SLOW_MS = 1500
const DEPENDENCY_SLOW_MS = 800
const MAX_SAMPLES = 20
const MAX_ROUTES = 25
const MAX_CAUSES = 8

function safeNumber(value) {
  const n = Number(value)
  return Number.isFinite(n) ? Math.max(0, n) : 0
}

function rounded(value) {
  return Math.round(safeNumber(value))
}

function normalizedText(value, max = 200) {
  return String(value ?? '').trim().slice(0, max)
}

function dependencyType(target) {
  const prefix = normalizedText(target, 300).split(' ')[0].toUpperCase()
  if (prefix === 'SUPABASE') return 'SUPABASE'
  if (prefix === 'CLOUDFLARE_R2') return 'CLOUDFLARE_R2'
  if (prefix === 'TELEGRAM') return 'TELEGRAM'
  if (prefix === 'UNKNOWN') return 'UNKNOWN'
  return 'OTHER_EXTERNAL'
}

function readTargets(evidence) {
  return (Array.isArray(evidence?.targets) ? evidence.targets : [])
    .slice(0, 12)
    .map((item) => ({
      provider: dependencyType(item?.target),
      target: normalizedText(item?.target, 220),
      calls: rounded(item?.count),
      errors: rounded(item?.errors),
      average_duration_ms: rounded(item?.avg_ms),
    }))
    .filter((item) => item.target && item.calls > 0)
    .sort((a, b) =>
      b.average_duration_ms - a.average_duration_ms || b.errors - a.errors
    )
}

function explainEvidence(evidence) {
  const duration = rounded(evidence?.duration_ms)
  const status = rounded(evidence?.http_status)
  const targets = readTargets(evidence)
  const slowest = targets[0] || null
  const failed = targets.find((target) => target.errors > 0) || null
  const reportedErrors = rounded(evidence?.observed_external_errors)

  let category = 'INSUFFICIENT_EVIDENCE'
  let confidence = 'low'
  let reason = 'No measured dependency establishes the source of the delay.'

  if (failed || reportedErrors > 0) {
    category = 'EXTERNAL_ERROR_OBSERVED'
    confidence = failed ? 'high' : 'medium'
    reason = failed
      ? `An outbound ${failed.provider} call returned an error in this request.`
      : 'At least one outbound call failed; the specific provider is not available.'
  } else if (slowest && slowest.average_duration_ms >= DEPENDENCY_SLOW_MS) {
    category = 'SLOW_EXTERNAL_CALL_OBSERVED'
    confidence = slowest.calls === 1 ? 'medium' : 'low'
    reason = `A ${slowest.provider} call averaged ${slowest.average_duration_ms} ms in this request. Causation is not yet proven.`
  } else if (duration >= SLOW_MS) {
    category = 'SLOW_BACKEND_UNATTRIBUTED'
    confidence = 'low'
    reason = 'Backend response was slow without a sufficiently slow measured outbound call; uninstrumented work may be involved.'
  } else if (status >= 500) {
    category = 'SERVER_ERROR_UNATTRIBUTED'
    confidence = 'low'
    reason = 'Backend returned a server error; more trace evidence is required.'
  }

  return {
    time: normalizedText(evidence?.time, 40) || null,
    request_id: normalizedText(evidence?.request_id, 100) || null,
    route: normalizedText(evidence?.route, 240),
    page: normalizedText(evidence?.page, 200),
    http_status: status,
    response_duration_ms: duration,
    cache: ['HIT', 'MISS', 'WAIT'].includes(evidence?.cache) ? evidence.cache : 'NOT_RECORDED',
    external_calls: rounded(evidence?.observed_external_calls),
    external_errors: reportedErrors,
    slowest_observed_target: slowest,
    evidence_category: category,
    confidence,
    explanation: reason,
    targets: targets.slice(0, 6),
  }
}

function createRouteSummary(pageRequests) {
  const merged = new Map()
  const rows = Array.isArray(pageRequests?.routes) ? pageRequests.routes : []
  for (const row of rows) {
    const route = normalizedText(row?.route, 240)
    if (!route || route === 'OTHER ROUTES' || route.startsWith('GET /api/admin/system-control')) continue

    const current = merged.get(route) || {
      route,
      requests: 0,
      errors_4xx: 0,
      errors_5xx: 0,
      supabase_calls: 0,
      external_calls: 0,
      total_duration_ms: 0,
      max_duration_ms: 0,
    }
    const requests = rounded(row?.requests)
    current.requests += requests
    current.errors_4xx += rounded(row?.errors_4xx)
    current.errors_5xx += rounded(row?.errors_5xx)
    current.supabase_calls += rounded(row?.supabase_calls)
    current.external_calls += rounded(row?.external_calls)
    current.total_duration_ms += requests * safeNumber(row?.average_duration_ms)
    current.max_duration_ms = Math.max(current.max_duration_ms, rounded(row?.duration_max_ms))
    merged.set(route, current)
  }

  return [...merged.values()].map(({ total_duration_ms, ...row }) => ({
    ...row,
    average_duration_ms: row.requests ? Math.round(total_duration_ms / row.requests) : 0,
    observed_slowest_request_ms: row.max_duration_ms,
    supabase_calls_per_request: row.requests
      ? Number((row.supabase_calls / row.requests).toFixed(2))
      : 0,
  })).sort((a, b) =>
    b.average_duration_ms - a.average_duration_ms ||
    b.observed_slowest_request_ms - a.observed_slowest_request_ms
  ).slice(0, MAX_ROUTES)
}

function summarizeCauseCounts(samples) {
  const counts = new Map()
  for (const sample of samples) {
    const target = sample.slowest_observed_target?.provider || 'UNATTRIBUTED'
    const key = `${sample.evidence_category}:${target}`
    const value = counts.get(key) || {
      category: sample.evidence_category,
      provider: target,
      sampled_requests: 0,
      longest_response_ms: 0,
    }
    value.sampled_requests += 1
    value.longest_response_ms = Math.max(value.longest_response_ms, sample.response_duration_ms)
    counts.set(key, value)
  }
  return [...counts.values()]
    .sort((a, b) => b.sampled_requests - a.sampled_requests || b.longest_response_ms - a.longest_response_ms)
    .slice(0, MAX_CAUSES)
}

export function getAdminPerformanceDiagnostics({ evidence = [], pageRequests = null } = {}) {
  const source = Array.isArray(evidence) ? evidence : []
  const measured = source.map(explainEvidence)
    .filter((item) => item.route && item.response_duration_ms >= 0)
  const relevant = measured.filter((item) =>
    item.response_duration_ms >= SLOW_MS ||
    item.http_status >= 500 ||
    item.external_errors > 0
  )
  const topSamples = [...relevant]
    .sort((a, b) => b.response_duration_ms - a.response_duration_ms)
    .slice(0, MAX_SAMPLES)

  return {
    generated_at: new Date().toISOString(),
    result: relevant.length ? 'OBSERVATIONS_AVAILABLE' : 'INSUFFICIENT_EVIDENCE',
    scope: 'BACKEND_API_ONLY',
    status: 'READ_ONLY',
    coverage: {
      request_summary_window_minutes: rounded(pageRequests?.window_minutes) || 60,
      sampled_evidence_count: measured.length,
      sampled_slow_or_failed_count: relevant.length,
      capture_policy: 'Only slow, failed, or high-external-call requests are sampled; not every request.',
      restart_policy: 'In-memory samples may be lost when Render restarts.',
      limitations: [
        'The samples are biased toward slow or failed requests; do not treat them as all traffic.',
        'No p95 or p99 latency is calculated from these biased samples.',
        'Dependency times may overlap and cannot be subtracted from total response time.',
        'Direct browser-to-Cloudflare R2 image loading is not measured here.',
        'Without corresponding Render CPU/memory and browser timings, no root cause is confirmed.',
        'Monitoring starts with measurements available after deployment; absent older timing cannot be recreated.',
      ],
    },
    totals: {
      observed_requests_in_page_monitor: rounded(pageRequests?.totals?.requests),
      observed_4xx: rounded(pageRequests?.totals?.errors_4xx),
      observed_5xx: rounded(pageRequests?.totals?.errors_5xx),
      observed_supabase_calls: rounded(pageRequests?.totals?.supabase_calls),
      observed_external_calls: rounded(pageRequests?.totals?.external_calls),
    },
    route_performance: createRouteSummary(pageRequests),
    sample_cause_groups: summarizeCauseCounts(relevant),
    slow_request_evidence: topSamples,
    next_evidence_needed: [
      'Browser image resource timings with image host and error status',
      'Render CPU, memory, and restart metrics aligned by time',
      'Supabase slow-query evidence aligned by time',
    ],
  }
}
