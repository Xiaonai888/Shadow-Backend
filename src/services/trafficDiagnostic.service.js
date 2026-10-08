import http from 'node:http'
import https from 'node:https'
import { AsyncLocalStorage } from 'node:async_hooks'
import jwt from 'jsonwebtoken'
import { recordSystemUsage } from './systemUsageMonitor.service.js'

const ENABLED =
  String(process.env.TRAFFIC_DIAGNOSTIC_ENABLED ?? 'true')
    .trim()
    .toLowerCase() !== 'false'

const FLUSH_MS = 60 * 1000
const MAX_ROWS = 25
const MAX_KEYS_PER_MAP = 500
const inbound = new Map()
const outbound = new Map()
const requestContext = new AsyncLocalStorage()
const TRACE_SLOW_MS = 1500
const TRACE_MAX_ERRORS_PER_MINUTE = 8
const TRACE_MAX_EXPENSIVE_PER_MINUTE = 4
const RECENT_EVIDENCE_LIMIT = 120
const RECENT_EVIDENCE_TTL_MS = 60 * 60 * 1000
const MAX_EVIDENCE_TARGETS = 12
const MAX_EXTERNAL_FAILURES = 6
const MAX_EXTERNAL_FAILURE_TEXT = 240
let traceMinute = 0
let traceErrors = 0
let traceExpensive = 0
let traceSequence = 0
const recentEvidence = []

const ERROR_EVIDENCE_WINDOW_MS =
  15 * 60 * 1000
const ERROR_EVIDENCE_TTL_MS =
  2 * 60 * 60 * 1000
const ERROR_EVIDENCE_LIMIT = 5000
const historicalErrorEvidence =
  new Map()

function bytesOf(value, encoding) {
  if (value === null || value === undefined) return 0
  if (Buffer.isBuffer(value)) return value.length
  if (value instanceof Uint8Array) return value.byteLength
  if (value instanceof ArrayBuffer) return value.byteLength
  if (typeof value === 'string') return Buffer.byteLength(value, encoding)
  return 0
}

function normalizePath(value) {
  return String(value || '/')
    .split('?')[0]
    .split('/')
    .map((part) => {
      if (!part) return part
      if (/^\d+$/.test(part)) return ':id'
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(part)) return ':id'
      if (/^[0-9a-f]{16,}$/i.test(part)) return ':id'
      if (/^[A-Za-z0-9_-]{32,}$/.test(part)) return ':id'
      return part.slice(0, 100)
    })
    .join('/') || '/'
}

function getPublicStoriesSort(req, normalizedPath) {
  if (normalizedPath !== '/api/public/stories') {
    return ''
  }

  let value = 'latest'

  try {
    const url = new URL(
      req.originalUrl || req.url || '/',
      'http://shadow.local'
    )

    value =
      url.searchParams.get('sort') ||
      'latest'
  } catch {
    value = 'latest'
  }

  const cleanValue = String(value || 'latest')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '')
    .slice(0, 40)

  return cleanValue || 'latest'
}

function getPublicStoriesCacheState(res) {
  const value = String(
    res.getHeader(
      'X-Shadow-Public-Stories-Cache'
    ) || 'NONE'
  )
    .trim()
    .toUpperCase()

  return ['HIT', 'MISS', 'WAIT'].includes(
    value
  )
    ? value
    : 'NONE'
}

function isSseResponse(res) {
  const contentType = String(
    res?.getHeader?.('Content-Type') ||
      ''
  )
    .trim()
    .toLowerCase()

  return contentType.includes(
    'text/event-stream'
  )
}

function logSseLifecycleEvidence({
  context,
  res,
  startedAt,
  elapsedMs,
  closeReason,
  responseBytes,
}) {
  if (!context) return

  console.log(
    'SYSTEM_SSE_LIFECYCLE',
    JSON.stringify({
      request_id:
        context.request_id,
      route:
        context.route,
      http_status:
        Number(
          res?.statusCode || 0
        ),
      connected_at:
        new Date(
          startedAt
        ).toISOString(),
      disconnected_at:
        new Date().toISOString(),
      lifetime_ms:
        Math.max(
          0,
          Number(elapsedMs) || 0
        ),
      close_reason:
        String(
          closeReason || 'unknown'
        ).slice(0, 40),
      response_bytes:
        Math.max(
          0,
          Number(responseBytes) || 0
        ),
      observed_external_calls:
        Number(
          context.external_calls || 0
        ),
      observed_external_errors:
        Number(
          context.external_errors || 0
        ),
    })
  )
}

function destination(hostname) {
  const host = String(hostname || '').toLowerCase()
  if (!host) return 'UNKNOWN'
  if (host.endsWith('.supabase.co')) return 'SUPABASE'
  if (host.includes('r2.cloudflarestorage.com')) return 'CLOUDFLARE_R2'
  if (host === 'api.telegram.org') return 'TELEGRAM'
  if (host === 'ipwho.is' || host.endsWith('.ipwho.is')) return 'IPWHO'
  return `OTHER:${host}`
}

function add(map, key, bytes = 0, error = false, durationMs = 0) {
  const overflowKey = map === outbound ? 'OVERFLOW:OUTBOUND' : 'OVERFLOW:INBOUND'
  const mapKey = map.has(key) || map.size < MAX_KEYS_PER_MAP - 1
    ? key
    : overflowKey
  const current = map.get(mapKey) || {
    count: 0,
    bytes: 0,
    errors: 0,
    duration_ms: 0,
  }

  current.count += 1
  current.bytes += Math.max(0, Number(bytes) || 0)
  current.errors += error ? 1 : 0
  current.duration_ms += Math.max(0, Number(durationMs) || 0)
  map.set(mapKey, current)

  recordSystemUsage({
    kind: map === outbound ? 'external_request' : 'http_response',
    key,
    bytes,
    error,
    duration_ms: durationMs,
  })
}

function recordDependency(context, target, failed, durationMs = 0) {
  if (!context) return

  context.external_calls += 1
  if (failed) context.external_errors += 1

  if (!context.targets.has(target) && context.targets.size >= MAX_EVIDENCE_TARGETS) {
    context.dropped_targets += 1
    return
  }

  const current = context.targets.get(target) || {
    count: 0,
    errors: 0,
    duration_ms: 0,
  }

  current.count += 1
  current.errors += failed ? 1 : 0
  current.duration_ms += Math.max(0, Number(durationMs) || 0)
  context.targets.set(target, current)
}

function cleanExternalFailureText(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_EXTERNAL_FAILURE_TEXT)
}

function recordExternalFailure(context, details = {}) {
  if (!context) return

  if (!Array.isArray(context.external_failures)) {
    context.external_failures = []
  }

  if (
    context.external_failures.length >=
    MAX_EXTERNAL_FAILURES
  ) {
    return
  }

  const status = Number(details.status || 0)
  const failure = {
    provider:
      cleanExternalFailureText(details.provider) ||
      'UNKNOWN',
    target:
      cleanExternalFailureText(details.target) ||
      'UNKNOWN',
    status:
      Number.isFinite(status) ? status : 0,
  }

  for (const key of [
    'status_text',
    'code',
    'message',
    'details',
    'hint',
    'error_name',
  ]) {
    const value =
      cleanExternalFailureText(details[key])

    if (value) failure[key] = value
  }

  context.external_failures.push(failure)
}

async function captureFetchFailure({
  context,
  response,
  target,
  provider,
}) {
  const failure = {
    provider,
    target,
    status: Number(response?.status || 0),
    status_text: response?.statusText || '',
  }

  if (
    provider === 'SUPABASE' &&
    response
  ) {
    try {
      const payload =
        await response.clone().json()

      if (
        payload &&
        typeof payload === 'object'
      ) {
        failure.code =
          payload.code || ''
        failure.message =
          payload.message || ''
        failure.details =
          payload.details || ''
        failure.hint =
          payload.hint || ''
      }
    } catch {
      failure.code =
        failure.code ||
        'SUPABASE_HTTP_ERROR'
    }
  }

  recordExternalFailure(
    context,
    failure
  )
}

function diagnosticActor(req) {
  const userId = req.user?.user_id || req.user?.admin_id || req.user?.id
  if (userId) return { type: 'authenticated', id: String(userId).slice(0, 120) }

  try {
    const header = String(req.headers.authorization || '')
    if (!header.startsWith('Bearer ') || !process.env.JWT_SECRET) return { type: 'anonymous' }
    const decoded = jwt.verify(header.slice(7), process.env.JWT_SECRET)
    if (!['reader', 'admin'].includes(decoded?.type)) return { type: 'anonymous' }
    const verified = decoded.user_id || decoded.admin_id || decoded.id
    return verified
      ? { type: 'authenticated', id: String(verified).slice(0, 120) }
      : { type: 'anonymous' }
  } catch {
    return { type: 'anonymous' }
  }
}

function buildTargetEvidence(context) {
  return [...context.targets.entries()]
    .map(([target, value]) => ({
      target,
      count: Number(value?.count || 0),
      errors: Number(value?.errors || 0),
      avg_ms: value?.count
        ? Number((Number(value.duration_ms || 0) / Number(value.count)).toFixed(1))
        : 0,
    }))
    .sort(
      (a, b) =>
        b.count - a.count ||
        b.errors - a.errors ||
        b.avg_ms - a.avg_ms
    )
}

function cleanDiagnosticMarker(details = {}) {
  const result = {}

  for (const [rawKey, rawValue] of Object.entries(details)) {
    const key = String(rawKey || '')
      .trim()
      .replace(/[^a-zA-Z0-9_]/g, '')
      .slice(0, 60)

    if (!key || rawValue === null || rawValue === undefined || rawValue === '') {
      continue
    }

    if (typeof rawValue === 'number') {
      if (Number.isFinite(rawValue)) result[key] = rawValue
      continue
    }

    if (typeof rawValue === 'boolean') {
      result[key] = rawValue
      continue
    }

    result[key] = String(rawValue).slice(0, 160)
  }

  return result
}

export function markRequestDiagnostic(details = {}) {
  const context = requestContext.getStore()

  if (!context) return false

  context.diagnostic_marker = {
    ...(context.diagnostic_marker || {}),
    ...cleanDiagnosticMarker(details),
  }

  return true
}

function cleanHistoricalErrorText(
  value,
  maxLength = 180
) {
  return String(value ?? '')
    .replace(
      /Bearer\s+\S+/gi,
      'Bearer [redacted]'
    )
    .replace(
      /\b[A-Za-z0-9_-]{48,}\b/g,
      '[redacted]'
    )
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength)
}

function historicalErrorClass(
  status,
  context
) {
  if (
    Number(status) >= 500 ||
    Number(
      context?.external_errors || 0
    ) > 0
  ) {
    return 'internal_error'
  }

  if (Number(status) === 429) {
    return 'rate_limited'
  }

  if (Number(status) >= 400) {
    return 'user_error'
  }

  return 'external_error'
}

function pruneHistoricalErrorEvidence(
  now = Date.now()
) {
  const cutoff =
    now - ERROR_EVIDENCE_TTL_MS

  for (
    const [key, entry]
    of historicalErrorEvidence
  ) {
    if (
      Number(
        entry?.window_end_ms || 0
      ) <= cutoff
    ) {
      historicalErrorEvidence.delete(
        key
      )
    }
  }

  while (
    historicalErrorEvidence.size >
    ERROR_EVIDENCE_LIMIT
  ) {
    historicalErrorEvidence.delete(
      historicalErrorEvidence
        .keys()
        .next()
        .value
    )
  }
}

function recordHistoricalErrorEvidence(
  req,
  res,
  context,
  elapsedMs
) {
  if (
    !context ||
    context.route.startsWith(
      'GET /api/admin/system-control'
    )
  ) {
    return
  }

  const status =
    Number(res.statusCode || 0)
  const externalErrors =
    Number(
      context.external_errors || 0
    )

  if (
    status < 400 &&
    externalErrors <= 0
  ) {
    return
  }

  const now = Date.now()
  const windowStart =
    Math.floor(
      now /
      ERROR_EVIDENCE_WINDOW_MS
    ) *
    ERROR_EVIDENCE_WINDOW_MS
  const windowEnd =
    windowStart +
    ERROR_EVIDENCE_WINDOW_MS
  const failures =
    Array.isArray(
      context.external_failures
    )
      ? context.external_failures
      : []
  const firstFailure =
    failures[0] || null
  const provider =
    cleanHistoricalErrorText(
      firstFailure?.provider ||
      (
        externalErrors > 0
          ? 'EXTERNAL'
          : 'APPLICATION'
      ),
      80
    ) || 'APPLICATION'
  const target =
    cleanHistoricalErrorText(
      firstFailure?.target ||
      context.route,
      300
    ) || context.route
  const marker =
    context.diagnostic_marker &&
    typeof context.diagnostic_marker ===
      'object'
      ? context.diagnostic_marker
      : null
  const sampleError =
    cleanHistoricalErrorText(
      firstFailure?.message ||
      firstFailure?.details ||
      firstFailure?.code ||
      firstFailure?.status_text ||
      marker?.error_code ||
      (
        marker?.feed_result === 'error'
          ? 'feed_result:error'
          : ''
      ) ||
      `HTTP ${status || 0}`
    )
  const errorClass =
    historicalErrorClass(
      status,
      context
    )
  const key = [
    windowStart,
    context.route,
    status,
    errorClass,
    provider,
    target,
  ].join('\u001f')

  const current =
    historicalErrorEvidence.get(
      key
    ) || {
      window_start_ms:
        windowStart,
      window_end_ms:
        windowEnd,
      route: context.route,
      http_status: status,
      error_class:
        errorClass,
      provider,
      target,
      count: 0,
      first_seen_at:
        new Date(now).toISOString(),
      last_seen_at:
        new Date(now).toISOString(),
      sample_request_id:
        context.request_id || null,
      sample_error:
        sampleError || null,
      sample_duration_ms:
        Math.max(
          0,
          Number(elapsedMs) || 0
        ),
      external_error_count: 0,
    }

  current.count += 1
  current.last_seen_at =
    new Date(now).toISOString()
  current.external_error_count +=
    externalErrors

  if (
    !current.sample_error &&
    sampleError
  ) {
    current.sample_error =
      sampleError
  }

  historicalErrorEvidence.set(
    key,
    current
  )

  pruneHistoricalErrorEvidence(
    now
  )
}

function logRequestEvidence(req, res, context, elapsedMs) {
  if (!context || context.route.startsWith('GET /api/admin/system-control')) return

  recordHistoricalErrorEvidence(
    req,
    res,
    context,
    elapsedMs
  )

  const status = Number(res.statusCode || 0)
  const sseResponse =
    isSseResponse(res)
  const failed = status === 429 || status >= 500 || context.external_errors > 0
  const expensive = context.external_calls >= 8 ||
    (
      !sseResponse &&
      elapsedMs >= TRACE_SLOW_MS &&
      context.external_calls > 0
    )
  if (!failed && !expensive) return

  const minute = Math.floor(Date.now() / 60000)
  if (minute !== traceMinute) {
    traceMinute = minute
    traceErrors = 0
    traceExpensive = 0
  }

  if (failed) {
    if (traceErrors >= TRACE_MAX_ERRORS_PER_MINUTE) return
    traceErrors += 1
  } else {
    if (traceExpensive >= TRACE_MAX_EXPENSIVE_PER_MINUTE) return
    traceExpensive += 1
  }

  const visitor = String(req.headers['x-shadow-visitor-id'] || '')
  const visitorClaim = /^[a-zA-Z0-9._:-]{6,80}$/.test(visitor) ? visitor : null
  const cacheState = String(
    res.getHeader('X-Shadow-Recommendations-Cache') || 'NONE'
  ).toUpperCase()
  const targets = buildTargetEvidence(context)
  const supabaseCalls = targets
    .filter((item) => item.target.startsWith('SUPABASE '))
    .reduce((sum, item) => sum + item.count, 0)
  const externalFailures =
    Array.isArray(context.external_failures)
      ? context.external_failures
      : []
  const firstExternalFailure =
    externalFailures[0] || null
  const firstSupabaseFailure =
    externalFailures.find(
      (item) =>
        item.provider === 'SUPABASE'
    ) || null
  const diagnosticMarker =
    context.diagnostic_marker &&
    typeof context.diagnostic_marker === 'object'
      ? context.diagnostic_marker
      : null
  const reactionDiagnosticKind =
    diagnosticMarker?.feature === 'story_reaction_toggle'
      ? failed
        ? String(
            diagnosticMarker.error_code ||
              'reaction_toggle_failed'
          )
            .trim()
            .toLowerCase()
        : supabaseCalls >= 8
          ? 'reaction_high_db_fanout'
          : elapsedMs >= TRACE_SLOW_MS
            ? 'reaction_slow'
            : ''
      : ''
  const diagnosticKind =
    reactionDiagnosticKind ||
    (firstSupabaseFailure
      ? 'supabase_error'
      : firstExternalFailure
        ? 'external_error'
        : failed
          ? 'request_failure'
          : supabaseCalls >= 8
            ? 'database_fanout'
            : (
                !sseResponse &&
                elapsedMs >= TRACE_SLOW_MS
              )
              ? 'slow_request'
              : 'expensive_request')

  const evidence = {
    request_id: context.request_id,
    time: new Date().toISOString(),
    route: context.route,
    http_status: status,
    duration_ms: elapsedMs,
    account: diagnosticActor(req),
    visitor_claim: visitorClaim,
    cache: ['HIT', 'MISS', 'WAIT'].includes(cacheState) ? cacheState : 'NONE',
    diagnostic_kind: diagnosticKind,
    diagnostic_marker: diagnosticMarker,
    evidence_semantics: 'single_http_request_not_loop_proof',
    observed_external_calls: context.external_calls,
    observed_supabase_calls: supabaseCalls,
    observed_external_errors: context.external_errors,
    likely_failure_source:
      firstExternalFailure?.target || null,
    external_failures: externalFailures,
    dropped_targets: context.dropped_targets,
    targets,
  }

  recentEvidence.push(evidence)
  if (recentEvidence.length > RECENT_EVIDENCE_LIMIT) recentEvidence.shift()
  const groupKey = `${context.route}:${status}:${diagnosticKind}:${firstExternalFailure?.code || ''}`
if (logRequestEvidence.groupMinute !== minute) {
  logRequestEvidence.groupMinute = minute
  logRequestEvidence.groups = new Set()
}
if (logRequestEvidence.groups.has(groupKey)) return
logRequestEvidence.groups.add(groupKey)
console.warn('SYSTEM_REQUEST_EVIDENCE', JSON.stringify(evidence))
}

export function getHistoricalErrorEvidence({
  from,
  to,
} = {}) {
  const fromMs =
    Number.isFinite(Number(from))
      ? Number(from)
      : new Date(from || 0).getTime()
  const toMs =
    Number.isFinite(Number(to))
      ? Number(to)
      : new Date(
          to || Date.now()
        ).getTime()

  if (
    !Number.isFinite(fromMs) ||
    !Number.isFinite(toMs) ||
    toMs <= fromMs
  ) {
    return []
  }

  pruneHistoricalErrorEvidence()

  return [
    ...historicalErrorEvidence.values(),
  ]
    .filter(
      (entry) =>
        Number(
          entry.window_end_ms || 0
        ) > fromMs &&
        Number(
          entry.window_start_ms || 0
        ) < toMs
    )
    .map((entry) => ({
      window_start:
        new Date(
          entry.window_start_ms
        ).toISOString(),
      window_end:
        new Date(
          entry.window_end_ms
        ).toISOString(),
      route: entry.route,
      http_status:
        entry.http_status,
      error_class:
        entry.error_class,
      provider:
        entry.provider,
      target:
        entry.target,
      count:
        Number(entry.count || 0),
      external_error_count:
        Number(
          entry.external_error_count || 0
        ),
      first_seen_at:
        entry.first_seen_at,
      last_seen_at:
        entry.last_seen_at,
      sample_request_id:
        entry.sample_request_id,
      sample_error:
        entry.sample_error,
      sample_duration_ms:
        Number(
          entry.sample_duration_ms || 0
        ),
    }))
    .sort(
      (a, b) =>
        Number(b.count || 0) -
          Number(a.count || 0) ||
        new Date(
          b.last_seen_at || 0
        ).getTime() -
          new Date(
            a.last_seen_at || 0
          ).getTime()
    )
}

export function getRecentRequestEvidence() {
  const cutoff = Date.now() - RECENT_EVIDENCE_TTL_MS
  return recentEvidence.filter((entry) => Date.parse(entry.time) >= cutoff)
}

function rows(map) {
  return [...map.entries()]
    .map(([key, value]) => ({
      key,
      count: value.count,
      mb: Number((value.bytes / 1024 / 1024).toFixed(3)),
      errors: value.errors,
      avg_ms: value.count
        ? Number((value.duration_ms / value.count).toFixed(1))
        : 0,
    }))
    .sort((a, b) => b.mb - a.mb || b.count - a.count)
    .slice(0, MAX_ROWS)
}

function flush() {
  if (!ENABLED) return

  const snapshot = {
    window_seconds: FLUSH_MS / 1000,
    inbound: rows(inbound),
    outbound: rows(outbound),
  }

  console.log('TRAFFIC_DIAG_60S', JSON.stringify(snapshot))
  inbound.clear()
  outbound.clear()
}

function fetchRequestBytes(input, init = {}) {
  let total = bytesOf(init.body)

  try {
    const request = input instanceof Request ? input : null
    const url = new URL(request?.url || String(input))
    total += Buffer.byteLength(`${init.method || request?.method || 'GET'} ${url.pathname}${url.search}`)

    const headers = new Headers(init.headers || request?.headers || undefined)
    headers.forEach((value, key) => {
      total += Buffer.byteLength(key) + Buffer.byteLength(value) + 4
    })
  } catch {
    return total
  }

  return total
}

function installFetchDiagnostic() {
  if (!ENABLED || globalThis.__shadowTrafficFetchInstalled) return
  if (typeof globalThis.fetch !== 'function') return

  globalThis.__shadowTrafficFetchInstalled = true
  const nativeFetch = globalThis.fetch.bind(globalThis)

  globalThis.fetch = async (input, init = {}) => {
    const startedAt = Date.now()
    let url = null

    try {
      url = new URL(input instanceof Request ? input.url : String(input))
    } catch {
      return nativeFetch(input, init)
    }

    const method = String(
      init.method || (input instanceof Request ? input.method : 'GET') || 'GET'
    ).toUpperCase()
    const provider =
      destination(url.hostname)
    const target = `${provider} ${method} ${normalizePath(url.pathname)}`
    const context =
      requestContext.getStore()
    const key = `${context?.route || 'BACKGROUND'} -> ${target}`
    const requestBytes = fetchRequestBytes(input, init)

    try {
      const response = await nativeFetch(input, init)
      const elapsedMs = Date.now() - startedAt

      if (!response.ok) {
        await captureFetchFailure({
          context,
          response,
          target,
          provider,
        })
      }

      recordDependency(
        context,
        target,
        !response.ok,
        elapsedMs
      )
      add(
        outbound,
        key,
        requestBytes,
        !response.ok,
        elapsedMs
      )
      return response
    } catch (error) {
      const elapsedMs = Date.now() - startedAt

      recordExternalFailure(
        context,
        {
          provider,
          target,
          status: 0,
          code: 'FETCH_REJECTED',
          message:
            error?.message ||
            'External fetch failed',
          error_name:
            error?.name || 'Error',
        }
      )

      recordDependency(
        context,
        target,
        true,
        elapsedMs
      )
      add(outbound, key, requestBytes, true, elapsedMs)
      throw error
    }
  }
}

function httpMeta(args) {
  const first = args[0]

  try {
    if (first instanceof URL || typeof first === 'string') {
      const url = new URL(first)
      const options =
        args[1] && typeof args[1] === 'object' && !(args[1] instanceof Function)
          ? args[1]
          : {}

      return {
        hostname: url.hostname,
        method: String(options.method || 'GET').toUpperCase(),
        path: url.pathname,
      }
    }

    const options = first && typeof first === 'object' ? first : {}
    const rawHost = String(
      options.hostname || options.host || options.headers?.host || ''
    ).replace(/^\[|\]$/g, '')
    const hostname = rawHost.split(':')[0]

    return {
      hostname,
      method: String(options.method || 'GET').toUpperCase(),
      path: normalizePath(options.path || '/'),
    }
  } catch {
    return {
      hostname: '',
      method: 'GET',
      path: '/',
    }
  }
}

function installHttpDiagnostic(moduleObject) {
  if (!ENABLED || !moduleObject?.request) return

  const nativeRequest = moduleObject.request

  moduleObject.request = function wrappedRequest(...args) {
    const meta = httpMeta(args)
    const target = `${destination(meta.hostname)} ${meta.method} ${normalizePath(meta.path)}`
    const key = `${requestContext.getStore()?.route || 'BACKGROUND'} -> ${target}`
    const startedAt = Date.now()
    const context = requestContext.getStore()
    const request = nativeRequest.apply(this, args)
    let writtenBytes = 0
    let recorded = false

    const nativeWrite = request.write.bind(request)
    const nativeEnd = request.end.bind(request)

    request.write = (chunk, encoding, callback) => {
      writtenBytes += bytesOf(chunk, encoding)
      return nativeWrite(chunk, encoding, callback)
    }

    request.end = (chunk, encoding, callback) => {
      if (chunk !== undefined && chunk !== null) {
        writtenBytes += bytesOf(chunk, encoding)
      }
      return nativeEnd(chunk, encoding, callback)
    }

    const record = (error = false) => {
      if (recorded) return
      recorded = true
      const elapsedMs = Date.now() - startedAt
      recordDependency(context, target, error, elapsedMs)
      add(outbound, key, writtenBytes, error, elapsedMs)
    }

    request.once('response', (response) => {
      const status =
        Number(response.statusCode || 0)
      const failed = status >= 400

      if (failed) {
        recordExternalFailure(
          context,
          {
            provider:
              destination(meta.hostname),
            target,
            status,
            status_text:
              response.statusMessage || '',
            code: 'HTTP_ERROR',
          }
        )
      }

      record(failed)
    })
    request.once('error', (error) => {
      recordExternalFailure(
        context,
        {
          provider:
            destination(meta.hostname),
          target,
          status: 0,
          code: 'HTTP_REQUEST_ERROR',
          message:
            error?.message ||
            'HTTP request failed',
          error_name:
            error?.name || 'Error',
        }
      )
      record(true)
    })
    request.once('close', () => record(true))
    return request
  }
}

export function trafficDiagnosticMiddleware(req, res, next) {
  if (!ENABLED) return next()

  const startedAt = Date.now()
  const method = String(
    req.method || 'GET'
  ).toUpperCase()

  const normalizedPath = normalizePath(
    req.originalUrl ||
      req.url ||
      req.path
  )

  const publicStoriesSort =
    getPublicStoriesSort(
      req,
      normalizedPath
    )

  const sourceKey = publicStoriesSort
    ? `${method} ${normalizedPath}?sort=${publicStoriesSort}`
    : `${method} ${normalizedPath}`

  const context = {
    route: sourceKey,
    request_id: `${process.pid}-${startedAt}-${++traceSequence}`,
    external_calls: 0,
    external_errors: 0,
    external_failures: [],
    dropped_targets: 0,
    targets: new Map(),
    diagnostic_marker: null,
  }

  let responseBytes = 0
  let recorded = false

  const nativeWrite = res.write.bind(res)
  const nativeEnd = res.end.bind(res)

  res.write = (chunk, encoding, callback) => {
    responseBytes += bytesOf(
      chunk,
      encoding
    )
    return nativeWrite(
      chunk,
      encoding,
      callback
    )
  }

  res.end = (chunk, encoding, callback) => {
    if (
      chunk !== undefined &&
      chunk !== null
    ) {
      responseBytes += bytesOf(
        chunk,
        encoding
      )
    }

    return nativeEnd(
      chunk,
      encoding,
      callback
    )
  }

  const record = (
    closeReason = 'finish'
  ) => {
    if (recorded) return
    recorded = true

    const recommendationCache = normalizedPath.endsWith('/recommendations')
      ? String(
          res.getHeader('X-Shadow-Recommendations-Cache') || 'NONE'
        ).toUpperCase()
      : ''

    const key = recommendationCache
      ? `${sourceKey}?cache=${recommendationCache}&status=${Number(res.statusCode || 0)}`
      : publicStoriesSort
        ? `${sourceKey}&cache=${getPublicStoriesCacheState(
            res
          )}&status=${Number(
            res.statusCode || 0
          )}`
        : sourceKey

    const elapsedMs =
      Date.now() - startedAt
    const sseResponse =
      isSseResponse(res)
    const usageDurationMs =
      sseResponse
        ? 0
        : elapsedMs

    add(
      inbound,
      key,
      responseBytes,
      res.statusCode >= 400,
      usageDurationMs
    )

    if (sseResponse) {
      logSseLifecycleEvidence({
        context,
        res,
        startedAt,
        elapsedMs,
        closeReason,
        responseBytes,
      })
    }

    logRequestEvidence(
      req,
      res,
      context,
      elapsedMs
    )
  }

  res.once(
    'finish',
    () => record('finish')
  )
  res.once(
    'close',
    () => record('close')
  )
  req.once(
    'aborted',
    () => record('aborted')
  )

  requestContext.run(
    context,
    next
  )
}

if (ENABLED) {
  installFetchDiagnostic()
  installHttpDiagnostic(http)
  installHttpDiagnostic(https)
  const timer = setInterval(flush, FLUSH_MS)
  timer.unref?.()
  console.log('TRAFFIC_DIAG: enabled')
}
