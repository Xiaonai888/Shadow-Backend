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
const inbound = new Map()
const outbound = new Map()
const requestContext = new AsyncLocalStorage()
const TRACE_SLOW_MS = 1500
const TRACE_MAX_ERRORS_PER_MINUTE = 8
const TRACE_MAX_EXPENSIVE_PER_MINUTE = 4
let traceMinute = 0
let traceErrors = 0
let traceExpensive = 0
let traceSequence = 0

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
  const current = map.get(key) || {
    count: 0,
    bytes: 0,
    errors: 0,
    duration_ms: 0,
  }

  current.count += 1
  current.bytes += Math.max(0, Number(bytes) || 0)
  current.errors += error ? 1 : 0
  current.duration_ms += Math.max(0, Number(durationMs) || 0)
  map.set(key, current)

  recordSystemUsage({
    kind: map === outbound ? 'external_request' : 'http_response',
    key,
    bytes,
    error,
    duration_ms: durationMs,
  })
}

function recordDependency(context, target, failed) {
  if (!context) return
  context.external_calls += 1
  if (failed) context.external_errors += 1
  if (context.targets.size < 8 || context.targets.has(target)) {
    context.targets.set(target, (context.targets.get(target) || 0) + 1)
  }
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

function logRequestEvidence(req, res, context, elapsedMs) {
  if (!context || context.route.startsWith('GET /api/admin/system-control')) return

  const status = Number(res.statusCode || 0)
  const failed = status >= 500 || context.external_errors > 0
  const expensive = context.external_calls >= 8 ||
    (elapsedMs >= TRACE_SLOW_MS && context.external_calls > 0)
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
  const cacheState = String(res.getHeader('X-Shadow-Recommendations-Cache') || 'NONE').toUpperCase()
  console.warn('SYSTEM_REQUEST_EVIDENCE', JSON.stringify({
    request_id: context.request_id,
    time: new Date().toISOString(),
    route: context.route,
    http_status: status,
    duration_ms: elapsedMs,
    account: diagnosticActor(req),
    visitor_claim: visitorClaim,
    cache: ['HIT', 'MISS', 'WAIT'].includes(cacheState) ? cacheState : 'NONE',
    observed_external_calls: context.external_calls,
    observed_external_errors: context.external_errors,
    targets: [...context.targets.entries()].map(([target, count]) => ({ target, count })),
  }))
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
    const key = `${requestContext.getStore()?.route || 'BACKGROUND'} -> ${destination(url.hostname)} ${method} ${normalizePath(url.pathname)}`
    const requestBytes = fetchRequestBytes(input, init)

    try {
      const response = await nativeFetch(input, init)
      recordDependency(requestContext.getStore(), `${destination(url.hostname)} ${method} ${normalizePath(url.pathname)}`, !response.ok)
      add(
        outbound,
        key,
        requestBytes,
        !response.ok,
        Date.now() - startedAt
      )
      return response
    } catch (error) {
      recordDependency(requestContext.getStore(), `${destination(url.hostname)} ${method} ${normalizePath(url.pathname)}`, true)
      add(outbound, key, requestBytes, true, Date.now() - startedAt)
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
    const key = `${requestContext.getStore()?.route || 'BACKGROUND'} -> ${destination(meta.hostname)} ${meta.method} ${normalizePath(meta.path)}`
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
      recordDependency(context, `${destination(meta.hostname)} ${meta.method} ${normalizePath(meta.path)}`, error)
      add(outbound, key, writtenBytes, error, Date.now() - startedAt)
    }

    request.once('finish', () => record(false))
    request.once('error', () => record(true))
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
    targets: new Map(),
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

  const record = () => {
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

    const elapsedMs = Date.now() - startedAt
    add(
      inbound,
      key,
      responseBytes,
      res.statusCode >= 400,
      elapsedMs
    )
    logRequestEvidence(req, res, context, elapsedMs)
  }

  res.once('finish', record)
  res.once('close', record)

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
