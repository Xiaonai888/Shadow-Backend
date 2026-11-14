import { createHmac, randomBytes } from 'node:crypto'

const WINDOW_MS = 60_000
const MAX_WINDOWS = 60
const MAX_ROUTES_PER_WINDOW = 160
const MAX_ACTOR_KEYS = 5000
const ACTOR_TTL_MS = 120_000
const RAPID_REPEAT_THRESHOLD = 12
const secret = randomBytes(32)
const windows = new Map()
const actors = new Map()
let lastActorPrune = 0
let droppedActorObservations = 0
let droppedRouteObservations = 0

const metrics = [
  'requests',
  'client_reported_hidden_requests',
  'client_reported_visible_requests',
  'unknown_visibility_requests',
  'rapid_repeat_requests',
  'rapid_repeat_authenticated_requests',
  'errors_4xx',
  'errors_5xx',
  'supabase_calls',
  'external_calls',
  'response_bytes',
]

function number(value) {
  const result = Number(value)
  return Number.isFinite(result) ? Math.max(0, result) : 0
}

function safeLabel(value, fallback, limit) {
  return String(value || fallback).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, limit)
}

function pageLabel(context) {
  const value = safeLabel(context?.page, 'UNATTRIBUTED', 170)
  return /^(?:ADMIN|WEB):\//.test(value) ? value : 'UNATTRIBUTED'
}

function routeLabel(context) {
  return safeLabel(context?.route, 'UNKNOWN ROUTE', 210)
}

function actorIdentity(req) {
  const authorization = String(req?.headers?.authorization || '')
  if (/^Bearer\s+\S+/i.test(authorization)) {
    return { value: `authorization:${authorization}`, authenticated: true }
  }
  const visitor = String(req?.headers?.['x-shadow-visitor-id'] || '')
  if (/^[a-z0-9_-]{8,100}$/i.test(visitor)) {
    return { value: `visitor:${visitor}`, authenticated: false }
  }
  const address = String(req?.ip || req?.socket?.remoteAddress || '')
  const agent = String(req?.headers?.['user-agent'] || '')
  if (!address || !agent) return null
  return { value: `network:${address}:${agent.slice(0, 100)}`, authenticated: false }
}

function actorKey(value, route) {
  return createHmac('sha256', secret).update(value).update('\u001f').update(route).digest('hex')
}

function pruneActors(now) {
  if (now - lastActorPrune < WINDOW_MS) return
  lastActorPrune = now
  for (const [key, entry] of actors) {
    if (now - entry.lastSeenAt > ACTOR_TTL_MS) actors.delete(key)
  }
}

function isRapidRepeat(req, route, now) {
  if (String(req?.method || '').toUpperCase() !== 'GET') return { repeated: false, authenticated: false }
  pruneActors(now)
  const identity = actorIdentity(req)
  if (!identity) return { repeated: false, authenticated: false }
  const key = actorKey(identity.value, route)
  let state = actors.get(key)
  if (!state) {
    if (actors.size >= MAX_ACTOR_KEYS) {
      droppedActorObservations += 1
      return { repeated: false, authenticated: identity.authenticated }
    }
    state = { firstSeenAt: now, lastSeenAt: now, count: 0 }
    actors.set(key, state)
  }
  if (now < state.firstSeenAt || now - state.firstSeenAt >= WINDOW_MS) {
    state.firstSeenAt = now
    state.count = 0
  }
  state.count += 1
  state.lastSeenAt = now
  return { repeated: state.count >= RAPID_REPEAT_THRESHOLD, authenticated: identity.authenticated }
}

function emptyMetrics() {
  return Object.fromEntries(metrics.map((name) => [name, 0]))
}

export function observePassiveRequest(req, res, context, options = {}) {
  const method = String(req?.method || '').toUpperCase()
  const route = routeLabel(context)
  if (!context || !['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method) ||
      route.startsWith('GET /api/admin/system-control') ||
      route.startsWith('POST /api/admin/system-control')) return

  const now = Number.isFinite(options.now) ? options.now : Date.now()
  const windowKey = Math.floor(now / WINDOW_MS) * WINDOW_MS
  let window = windows.get(windowKey)
  if (!window) {
    window = new Map()
    windows.set(windowKey, window)
    for (const key of windows.keys()) {
      if (key < windowKey - (MAX_WINDOWS - 1) * WINDOW_MS || key > windowKey) windows.delete(key)
    }
  }

  let page = pageLabel(context)
  let routeName = route
  let key = `${page}\u001f${routeName}`
  if (!window.has(key) && window.size >= MAX_ROUTES_PER_WINDOW - 1) {
    droppedRouteObservations += 1
    page = 'OVERFLOW'
    routeName = 'OTHER ROUTES'
    key = `${page}\u001f${routeName}`
  }

  const row = window.get(key) || {
    page, route: routeName, ...emptyMetrics(),
    last_seen_at: null,
  }
  const visibility = String(req?.headers?.['x-shadow-visibility'] || '').toLowerCase()
  const isHidden = visibility === 'hidden'
  const isVisible = visibility === 'visible'
  const repeated = isRapidRepeat(req, route, now)
  const status = number(res?.statusCode)

  row.requests += 1
  row.client_reported_hidden_requests += Number(isHidden)
  row.client_reported_visible_requests += Number(isVisible)
  row.unknown_visibility_requests += Number(!isHidden && !isVisible)
  row.rapid_repeat_requests += Number(repeated.repeated)
  row.rapid_repeat_authenticated_requests += Number(repeated.repeated && repeated.authenticated)
  row.errors_4xx += Number(status >= 400 && status < 500)
  row.errors_5xx += Number(status >= 500)
  row.supabase_calls += number(context.supabase_calls)
  row.external_calls += number(context.external_calls)
  row.response_bytes += number(options.responseBytes)
  row.last_seen_at = new Date(now).toISOString()
  window.set(key, row)
}

function assess(row) {
  const signals = []
  if (row.client_reported_hidden_requests > 0) signals.push('CLIENT_REPORTED_HIDDEN_ACTIVITY')
  if (row.rapid_repeat_requests > 0) signals.push('RAPID_REPEAT_SUSPECTED')
  if (row.page === 'UNATTRIBUTED') signals.push('PAGE_SOURCE_UNKNOWN')
  if (row.page === 'OVERFLOW') signals.push('DETAIL_CAP_REACHED')
  return {
    ...row,
    signals,
    classification: signals.length > 0 ? 'REVIEW' : 'OBSERVED',
    inference_limit: 'No signal alone proves a request was unnecessary or that a page was inactive',
  }
}

export function getPassiveRequestSnapshot(options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now()
  const minutes = Math.min(MAX_WINDOWS, Math.max(1, Math.floor(number(options.minutes) || 60)))
  const from = Number.isFinite(options.from)
    ? options.from
    : Math.floor(now / WINDOW_MS) * WINDOW_MS - (minutes - 1) * WINDOW_MS
  const to = Number.isFinite(options.to) ? options.to : now + 1
  const grouped = new Map()
  const totals = emptyMetrics()
  let windowsObserved = 0

  for (const [windowKey, window] of windows) {
    if (windowKey + WINDOW_MS <= from || windowKey >= to) continue
    windowsObserved += 1
    for (const row of window.values()) {
      const key = `${row.page}\u001f${row.route}`
      const item = grouped.get(key) || {
        page: row.page,
        route: row.route,
        ...emptyMetrics(),
        last_seen_at: null,
      }
      for (const metric of metrics) {
        item[metric] += row[metric]
        totals[metric] += row[metric]
      }
      if (!item.last_seen_at || item.last_seen_at < row.last_seen_at) {
        item.last_seen_at = row.last_seen_at
      }
      grouped.set(key, item)
    }
  }

  const rows = [...grouped.values()].map(assess).sort((a, b) =>
    b.client_reported_hidden_requests - a.client_reported_hidden_requests ||
    b.rapid_repeat_requests - a.rapid_repeat_requests ||
    b.supabase_calls - a.supabase_calls ||
    b.requests - a.requests)
  const limit = Math.min(60, Math.max(1, Math.floor(number(options.limit) || 40)))

  return {
    mode: 'passive_existing_http_requests_only',
    verdict_policy: 'review_only_never_auto_block',
    measurement: 'observed_backend_requests_and_optional_unverified_client_visibility_header',
    persistence: 'memory_only_until_existing_15_minute_snapshot_integration',
    window_minutes: minutes,
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    windows_observed: windowsObserved,
    total_rows: rows.length,
    detail_capped: rows.length > limit,
    coverage: {
      route_capacity_per_minute: MAX_ROUTES_PER_WINDOW,
      dropped_actor_observations: droppedActorObservations,
      dropped_route_observations: droppedRouteObservations,
      visibility_reported_by_client_only: true,
      user_navigation_not_independently_verified: true,
    },
    totals,
    rows: rows.slice(0, limit),
  }
}
