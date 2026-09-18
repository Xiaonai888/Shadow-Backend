function safeNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(0, number) : 0
}

function clean(value, maxLength = 500) {
  return String(value || '').trim().slice(0, maxLength)
}

function ratio(current, baseline) {
  const now = safeNumber(current)
  const normal = safeNumber(baseline)

  if (normal <= 0) {
    return now > 0 ? null : 1
  }

  return Number((now / normal).toFixed(2))
}

function confidenceLabel(value) {
  if (value >= 0.8) return 'high'
  if (value >= 0.6) return 'medium'
  return 'low'
}

function evidenceSummary(snapshot) {
  const current = snapshot?.current || {}
  const baseline = snapshot?.baseline || {}
  const driver = snapshot?.top_driver || {}

  return {
    classification: clean(
      snapshot?.classification || 'unknown',
      80
    ),
    signals: Array.isArray(snapshot?.signals)
      ? snapshot.signals.slice(0, 20)
      : [],
    feature: clean(driver.feature || 'unknown', 120),
    route: clean(driver.source_route || 'UNKNOWN', 300),
    method: clean(driver.source_method || 'UNKNOWN', 20),
    dependency: clean(driver.dependency || 'UNKNOWN', 120),
    requests: safeNumber(current.count),
    bytes: safeNumber(current.bytes),
    errors: safeNumber(current.errors),
    error_rate_percent: safeNumber(
      current.error_rate_percent
    ),
    request_ratio: ratio(
      current.count,
      baseline.count_15s
    ),
    byte_ratio: ratio(
      current.bytes,
      baseline.bytes_15s
    ),
    error_ratio: ratio(
      current.errors,
      baseline.errors_15s
    ),
    driver_requests: safeNumber(driver.count),
    driver_bytes: safeNumber(driver.bytes),
    driver_errors: safeNumber(driver.errors),
    driver_avg_ms: safeNumber(driver.avg_ms),
  }
}

function baseAdvisor(snapshot) {
  return {
    version: 1,
    status: 'suggestion_only',
    notice: 'Suggestion only — Review before apply.',
    generated_at: new Date().toISOString(),
    classification: clean(
      snapshot?.classification || 'unknown',
      80
    ),
    confidence: {
      score: 0.5,
      level: 'low',
    },
    what_happened:
      'System Control detected usage outside the recent normal baseline.',
    likely_cause:
      'The available evidence is not specific enough to identify one optimization cause.',
    recommended_fix: [
      'Review the top route, feature, and dependency before making changes.',
      'Compare request count, response size, errors, and latency with the normal baseline.',
      'Apply the smallest reversible optimization first and verify usage afterward.',
    ],
    why_it_helps:
      'Targeted changes reduce the chance of hiding the symptom while leaving the actual usage source unchanged.',
    expected_impact:
      'Potential reduction in unnecessary requests, transferred bytes, or repeated errors after the real driver is confirmed.',
    evidence: evidenceSummary(snapshot),
  }
}

function setConfidence(advisor, score) {
  const value = Math.max(
    0,
    Math.min(1, Number(score) || 0)
  )

  advisor.confidence = {
    score: Number(value.toFixed(2)),
    level: confidenceLabel(value),
  }

  return advisor
}

function hasSignal(snapshot, signal) {
  return Array.isArray(snapshot?.signals) &&
    snapshot.signals.includes(signal)
}

function isBackground(snapshot) {
  const driver = snapshot?.top_driver || {}
  const route = String(
    driver.source_route || ''
  ).toUpperCase()

  return (
    route === 'BACKGROUND' ||
    route.startsWith('WORKER ') ||
    String(
      driver.source_method || ''
    ).toUpperCase() === 'WORKER' ||
    ['background_job', 'background_egress'].includes(
      String(snapshot?.classification || '').toLowerCase()
    )
  )
}

function applyErrorRule(advisor, snapshot) {
  const driver = snapshot?.top_driver || {}

  advisor.what_happened =
    'Errors increased sharply above the recent baseline while the same work continued to generate traffic.'

  advisor.likely_cause =
    'Repeated failures or retries may be multiplying requests, dependency calls, and transferred data.'

  advisor.recommended_fix = [
    'Add bounded retry with exponential backoff and jitter around the failing operation.',
    'Stop retrying permanent 4xx-style failures and cap retry attempts for transient failures.',
    'Use a circuit breaker or temporary cooldown when the same dependency keeps failing.',
    'Log the final failure once with the route, dependency, and retry count so recurrence is easy to verify.',
  ]

  advisor.why_it_helps =
    'Backoff and retry limits prevent one failing request or job from creating a request storm against the backend or an external provider.'

  advisor.expected_impact =
    'Lower repeated request volume, lower dependency traffic, and faster recovery during provider or route failures.'

  return setConfidence(
    advisor,
    safeNumber(driver.errors) > 0 ? 0.9 : 0.82
  )
}

function applyBackgroundR2Rule(advisor) {
  advisor.what_happened =
    'A background or worker task produced unusually high Cloudflare R2 traffic.'

  advisor.likely_cause =
    'The worker may be reading, writing, deleting, or retrying storage objects one-by-one or repeating work that could be reused.'

  advisor.recommended_fix = [
    'Batch storage work where possible instead of issuing one remote operation per small item.',
    'Avoid downloading or uploading an object again when the same result can be reused from memory, metadata, or a cached intermediate result.',
    'Delete temporary objects after successful processing and keep failed cleanup in a bounded retry queue.',
    'Add retry backoff and idempotency so the same job cannot repeat the same R2 transfer after a timeout or restart.',
  ]

  advisor.why_it_helps =
    'Reducing repeated object operations directly lowers storage egress, request count, and worker time.'

  advisor.expected_impact =
    'Meaningful reduction in R2 calls and background data transfer, especially during large manga or media jobs.'

  return setConfidence(advisor, 0.94)
}

function applySupabaseRule(advisor, snapshot) {
  const driver = snapshot?.top_driver || {}

  advisor.what_happened =
    'Supabase activity rose above the recent baseline for the top route or background task.'

  advisor.likely_cause =
    'The same request or job may be making several database, auth, REST, realtime, or storage calls that could be combined or reused.'

  advisor.recommended_fix = [
    'Batch independent reads or writes when the operation supports it.',
    'Replace repeated per-item queries with one filtered query, join, RPC, or grouped lookup.',
    'Select only the columns needed by the caller and keep result limits explicit.',
    'Cache stable lookup data for a short period when the same route repeatedly requests identical information.',
  ]

  advisor.why_it_helps =
    'Fewer Supabase round trips reduce request count, backend latency, and provider traffic without changing the user-facing feature.'

  advisor.expected_impact =
    'Lower Supabase call volume and faster route execution, with the largest gain on repeated list or per-item workloads.'

  return setConfidence(
    advisor,
    safeNumber(driver.count) >= 10 ? 0.89 : 0.78
  )
}

function applyLargeResponseRule(advisor, snapshot) {
  const driver = snapshot?.top_driver || {}
  const method = String(
    driver.source_method || ''
  ).toUpperCase()

  advisor.what_happened =
    'Transferred bytes increased sharply, with one route or dependency contributing most of the measured data.'

  advisor.likely_cause =
    method === 'GET'
      ? 'A read endpoint may be returning a large list, unnecessary fields, repeated payloads, or media metadata in one response.'
      : 'The top operation is transferring more data than its recent baseline and may be processing oversized payloads or repeated remote data.'

  advisor.recommended_fix = [
    'Add or verify pagination and enforce a safe maximum page size.',
    'Return only fields required by the current screen instead of broad object selections.',
    'Compress text responses where the hosting path supports it and avoid embedding large repeated data in JSON.',
    'Cache stable GET results briefly when many callers request the same response.',
  ]

  advisor.why_it_helps =
    'Smaller responses reduce Render bandwidth and dependency traffic while also improving response time for readers and admins.'

  advisor.expected_impact =
    'Lower outbound bytes per request and better performance on list-heavy or repeated read endpoints.'

  return setConfidence(
    advisor,
    hasSignal(snapshot, 'bytes_spike') ? 0.9 : 0.76
  )
}

function applyRequestSpikeRule(advisor, snapshot) {
  const driver = snapshot?.top_driver || {}
  const method = String(
    driver.source_method || ''
  ).toUpperCase()

  advisor.what_happened =
    'Request volume rose sharply above the recent baseline for the top route.'

  advisor.likely_cause =
    method === 'GET'
      ? 'The client may be polling too frequently or repeatedly requesting the same GET data during one screen session.'
      : 'A repeated client action, loop, retry, or background trigger may be calling the same route more often than intended.'

  advisor.recommended_fix =
    method === 'GET'
      ? [
          'Reduce polling frequency and pause polling when the page is hidden or the data is unchanged.',
          'Deduplicate identical in-flight GET requests on the client or backend.',
          'Add a short cache window for stable responses and use conditional refresh only when data can change.',
          'Check React effects or timers for duplicate subscriptions after mount, navigation, or reconnect.',
        ]
      : [
          'Check for duplicate event handlers, loops, retries, or repeated job triggers.',
          'Make the operation idempotent so repeated delivery does not repeat expensive work.',
          'Add a short deduplication window when the same action can arrive more than once.',
          'Use bounded retry with backoff instead of immediate repeated calls.',
        ]

  advisor.why_it_helps =
    'Removing duplicate or overly frequent calls lowers backend load and provider usage without disabling the feature.'

  advisor.expected_impact =
    'Lower requests per minute, lower transferred data, and fewer false-positive overload incidents.'

  return setConfidence(
    advisor,
    method === 'GET' ? 0.9 : 0.82
  )
}

function applyBackgroundRule(advisor) {
  advisor.what_happened =
    'A background job or worker ran above its recent normal request or data level.'

  advisor.likely_cause =
    'The job may be processing too many items at once, repeating completed work, or retrying without enough delay.'

  advisor.recommended_fix = [
    'Process work in bounded batches with a clear concurrency limit.',
    'Store idempotency or completion state so restarted jobs skip finished items.',
    'Use exponential backoff for transient failures and a retry queue for work that cannot complete immediately.',
    'Cache or reuse remote results inside the job when many items need the same dependency data.',
  ]

  advisor.why_it_helps =
    'Bounded background work prevents one queue or worker from consuming a disproportionate share of backend, database, or storage traffic.'

  advisor.expected_impact =
    'Smoother background traffic with fewer spikes and less repeated provider usage.'

  return setConfidence(advisor, 0.86)
}

export function buildSystemUsageOptimizationAdvisor(
  snapshot = {}
) {
  const advisor = baseAdvisor(snapshot)
  const classification = String(
    snapshot?.classification || ''
  ).toLowerCase()
  const dependency = String(
    snapshot?.top_driver?.dependency || ''
  ).toUpperCase()

  if (
    hasSignal(snapshot, 'error_spike') ||
    classification === 'error_burst'
  ) {
    return applyErrorRule(advisor, snapshot)
  }

  if (
    isBackground(snapshot) &&
    dependency === 'CLOUDFLARE_R2'
  ) {
    return applyBackgroundR2Rule(advisor)
  }

  if (dependency === 'SUPABASE') {
    return applySupabaseRule(advisor, snapshot)
  }

  if (
    hasSignal(snapshot, 'bytes_spike') ||
    classification === 'dependency_egress'
  ) {
    return applyLargeResponseRule(advisor, snapshot)
  }

  if (
    hasSignal(snapshot, 'request_spike') ||
    classification === 'route_overload'
  ) {
    return applyRequestSpikeRule(advisor, snapshot)
  }

  if (isBackground(snapshot)) {
    return applyBackgroundRule(advisor)
  }

  return setConfidence(advisor, 0.55)
}
