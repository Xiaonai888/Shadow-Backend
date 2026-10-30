const WINDOW_MS = 5 * 60 * 1000
const SAMPLE_LIMIT = 24
const SLOW_MS = 8000
const MAX_REASONS = 24
const EXPECTED_REASONS = new Set([
  'fast_cooldown',
  'cooldown',
  'qualified_view_required',
])

let windowStartedAt = Date.now()
let requests = 0
let countedResponses = 0
let notCountedResponses = 0
let httpErrors = 0
let aborted = 0
let slowResponses = 0
let sampledIssues = 0
let suppressedIssues = 0
let reasons = new Map()
let statuses = new Map()

function label(value, fallback = 'unknown') {
  const text = String(value || '').slice(0, 64)
  return /^[a-zA-Z0-9_-]{1,64}$/.test(text) ? text : fallback
}

function uuid(value) {
  const text = String(value || '')
  return /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(text)
    ? text
    : 'invalid_uuid'
}

function increase(map, key) {
  const safeKey = label(key)
  if (!map.has(safeKey) && map.size >= MAX_REASONS) {
    map.set('other', (map.get('other') || 0) + 1)
    return
  }
  map.set(safeKey, (map.get(safeKey) || 0) + 1)
}

function rotateWindow(now) {
  if (now - windowStartedAt < WINDOW_MS) return
  if (requests > 0) {
    console.info('SHADOW_VIEW_DIAG_SUMMARY', JSON.stringify({
      from: new Date(windowStartedAt).toISOString(),
      to: new Date(now).toISOString(),
      requests,
      counted_responses: countedResponses,
      not_counted_responses: notCountedResponses,
      http_errors: httpErrors,
      aborted,
      slow_responses: slowResponses,
      reasons: Object.fromEntries(reasons),
      statuses: Object.fromEntries(statuses),
      sampled_issues: sampledIssues,
      suppressed_issues: suppressedIssues,
    }))
  }
  windowStartedAt = now
  requests = 0
  countedResponses = 0
  notCountedResponses = 0
  httpErrors = 0
  aborted = 0
  slowResponses = 0
  sampledIssues = 0
  suppressedIssues = 0
  reasons = new Map()
  statuses = new Map()
}

export function traceEpisodeView(req, res, next) {
  try {
    const startedAt = Date.now()
    rotateWindow(startedAt)
    requests += 1

    const mode = req.body?.mode === 'qualified' ? 'qualified' : 'fast'
    let recorded = false
    const capture = (body, completedByJson = true) => {
      if (recorded) return
      recorded = true
      try {
        const status = Number(res.statusCode || 0)
        const elapsed = Date.now() - startedAt
        const counted = body?.view?.counted === true
        const reason = completedByJson
          ? label(body?.view?.reason || body?.code || (counted ? 'counted' : 'missing_view_result'))
          : label(status ? 'non_json_response' : 'connection_closed')
        const failed = status >= 400 || body?.ok === false
        const isAborted = !completedByJson && !res.writableEnded
        const unexpected = !counted && !failed && !isAborted && !EXPECTED_REASONS.has(reason)
        const isSlow = elapsed >= SLOW_MS

        if (counted) countedResponses += 1
        else notCountedResponses += 1
        if (failed) httpErrors += 1
        if (isAborted) aborted += 1
        if (isSlow) slowResponses += 1
        increase(statuses, status || 'no_status')
        increase(reasons, reason)

        if (failed || isAborted || unexpected || isSlow) {
          if (sampledIssues < SAMPLE_LIMIT) {
            sampledIssues += 1
            console.warn('SHADOW_VIEW_DIAG_ISSUE', JSON.stringify({
              time: new Date().toISOString(),
              story_id: uuid(req.params?.storyId),
              episode_id: uuid(req.params?.episodeId),
              mode,
              status,
              counted,
              reason,
              elapsed_ms: elapsed,
              aborted: isAborted,
              slow: isSlow,
            }))
          } else {
            suppressedIssues += 1
          }
        }
      } catch {}
    }

    const originalJson = res.json.bind(res)
    res.json = (body) => {
      capture(body)
      return originalJson(body)
    }
    res.once('finish', () => capture(null, false))
    res.once('close', () => {
      if (!res.writableEnded) capture(null, false)
    })
  } catch {}
  next()
}
