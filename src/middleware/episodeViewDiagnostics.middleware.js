import { markRequestDiagnostic } from '../services/trafficDiagnostic.service.js'

const WINDOW_MS = 5 * 60 * 1000
const SAMPLE_LIMIT = 16
const SLOW_MS = 2000
const MAX_REASONS = 24
const EXPECTED_VIEW_REASONS = new Set([
  'fast_cooldown', 'cooldown', 'qualified_view_required',
])

const windows = new Map()

function safeLabel(value, fallback = 'unknown') {
  const text = String(value ?? '').trim().slice(0, 64)
  return /^[a-zA-Z0-9_-]{1,64}$/.test(text) ? text : fallback
}

function safeUuid(value) {
  const text = String(value ?? '')
  return /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(text)
    ? text
    : 'invalid_uuid'
}

function bump(target, key) {
  const name = safeLabel(key)
  if (!target.has(name) && target.size >= MAX_REASONS) {
    target.set('other', (target.get('other') || 0) + 1)
  } else {
    target.set(name, (target.get(name) || 0) + 1)
  }
}

function newWindow(now) {
  return {
    startedAt: now, requests: 0, counted: 0, notCounted: 0,
    errors: 0, expected4xx: 0, serverErrors: 0, aborted: 0,
    slow: 0, sampled: 0, suppressed: 0, totalMs: 0,
    statuses: new Map(), reasons: new Map(),
  }
}

function rotate(operation, now) {
  let state = windows.get(operation)
  if (state && now - state.startedAt < WINDOW_MS) return state
  if (state && state.requests) {
    console.info('SHADOW_READER_API_DIAG_SUMMARY', JSON.stringify({
      operation,
      from: new Date(state.startedAt).toISOString(),
      to: new Date(now).toISOString(),
      requests: state.requests,
      counted_responses: state.counted,
      not_counted_responses: state.notCounted,
      errors: state.errors,
      expected_4xx: state.expected4xx,
      server_errors: state.serverErrors,
      aborted: state.aborted,
      slow_responses: state.slow,
      avg_ms: Math.round(state.totalMs / state.requests),
      statuses: Object.fromEntries(state.statuses),
      reasons: Object.fromEntries(state.reasons),
      sampled_issues: state.sampled,
      suppressed_issues: state.suppressed,
    }))
  }
  state = newWindow(now)
  windows.set(operation, state)
  return state
}

function classify(status, body, aborted, operation) {
  if (aborted) return 'connection_closed'
  if (status === 401) return 'unauthorized'
  if (status === 403) return 'forbidden'
  if (status === 404) return 'not_found'
  if (status === 423) return 'episode_locked'
  if (status === 429) return 'rate_limited'
  if (status >= 500) return 'server_error'
  if (status >= 400) return 'client_error'
  if (body?.ok === false) return 'application_rejected'
  if (operation === 'episode_view') {
    if (body?.view?.counted === true) return 'counted'
    return safeLabel(body?.view?.reason || body?.code || 'missing_view_result')
  }
  return 'ok'
}

function traceOperation(operation) {
  return (req, res, next) => {
    const startedAt = Date.now()
    const state = rotate(operation, startedAt)
    state.requests += 1
    let captured = false

    function capture(body, fromJson) {
      if (captured) return
      captured = true
      const status = Number(res.statusCode || 0)
      const elapsed = Math.max(0, Date.now() - startedAt)
      const aborted = !fromJson && !res.writableEnded && res.destroyed
      const reason = classify(status, body, aborted, operation)
      const counted = body?.view?.counted === true
      const isSlow = elapsed >= SLOW_MS
      const errorCode = safeLabel(body?.code || (status >= 500 ? 'HTTP_5XX' : 'none'))
      const expected4xx = [401, 403, 404, 423, 429].includes(status)
      const isError = status >= 400 || body?.ok === false

      state.totalMs += elapsed
      if (operation === 'episode_view') {
        if (counted) state.counted += 1
        else state.notCounted += 1
      }
      if (isError) state.errors += 1
      if (expected4xx) state.expected4xx += 1
      if (status >= 500) state.serverErrors += 1
      if (aborted) state.aborted += 1
      if (isSlow) state.slow += 1
      bump(state.statuses, String(status || 0))
      bump(state.reasons, reason)

      markRequestDiagnostic({
        read_operation: operation,
        read_result: reason,
        read_http_status: status,
        read_duration_ms: elapsed,
        read_error_code: errorCode,
        ...(operation === 'episode_view'
          ? { read_view_counted: counted, read_mode: req.body?.mode === 'qualified' ? 'qualified' : 'fast' }
          : {}),
      })

      const unexpectedView = operation === 'episode_view' && status < 400 &&
        !counted && !EXPECTED_VIEW_REASONS.has(reason)
      if (status >= 500 || aborted || isSlow || unexpectedView ||
          (status >= 400 && !expected4xx)) {
        if (state.sampled >= SAMPLE_LIMIT) {
          state.suppressed += 1
        } else {
          state.sampled += 1
          console.warn('SHADOW_READER_API_DIAG_ISSUE', JSON.stringify({
            operation, time: new Date().toISOString(), status,
            elapsed_ms: elapsed, reason, error_code: errorCode,
            aborted, slow: isSlow,
            story_id: safeUuid(req.params?.storyId),
            episode_id: safeUuid(req.params?.episodeId),
          }))
        }
      }
    }

    const originalJson = res.json.bind(res)
    res.json = (body) => {
      capture(body, true)
      return originalJson(body)
    }
    res.once('finish', () => capture(null, false))
    res.once('close', () => {
      if (!res.writableEnded) capture(null, false)
    })
    next()
  }
}

export const traceEpisodeView = traceOperation('episode_view')
export const traceReaderEpisodeList = traceOperation('episode_list')
export const traceReaderEpisodeDetail = traceOperation('episode_detail')
export const traceReadingProgressRead = traceOperation('reading_progress_get')
export const traceReadingProgressSave = traceOperation('reading_progress_post')
