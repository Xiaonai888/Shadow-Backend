import { isIP } from 'node:net'
import {
  recordWorkIncidentActive,
  recordWorkIncidentResolved,
  startWorkIncidentCleanup,
} from '../services/workIncident.service.js'
import { publishWorkRealtimeEvent } from '../services/workRealtime.service.js'
import { defendIps, releaseIps } from '../services/ipsCore.service.js'
import {
  publishSecurityEvent,
  reportGuardState,
} from '../services/securityControlPlane.service.js'

const ANALYZE_INTERVAL_MS = 15000
const ENTRY_IDLE_TTL_MS = 30 * 60 * 1000
const RESOLVED_TTL_MS = 10 * 60 * 1000
const MAX_ROUTE_TRACKED_KEYS = 500
const MAX_IDENTITY_TRACKED_KEYS = 1000
const IP_FALLBACK_MULTIPLIER = 5
const MIN_RISING_COUNT = 40
const NEW_SIGNAL_COUNT = 75
const SUSTAINED_HIGH_COUNT = 120
const IMMEDIATE_ACTIVE_COUNT = 250
const ISOLATE_COUNT = 500
const RISING_FACTOR = 2.5
const ACTIVE_WINDOWS_REQUIRED = 2
const RECOVERY_SAFE_COUNT = 15
const RECOVERY_WINDOWS_REQUIRED = 4

const routeTrackers = new Map()
const identityTrackers = new Map()
let monitorTimer = null
let enabled = true

function cleanText(value, maxLength = 500) {
  return String(value || '').trim().slice(0, maxLength)
}

function normalizeSingleIp(value) {
  const raw = cleanText(value, 150)
    .trim()
    .replace(/^::ffff:/, '')

  return isIP(raw) ? raw : ''
}

function getForwardedIp(value) {
  return String(value || '')
    .split(',')
    .map((item) => normalizeSingleIp(item))
    .find(Boolean) || ''
}

function getClientIp(req) {
  return (
    normalizeSingleIp(req.headers['cf-connecting-ip'])
    || normalizeSingleIp(req.headers['true-client-ip'])
    || normalizeSingleIp(req.headers['x-real-ip'])
    || getForwardedIp(req.headers['x-forwarded-for'])
    || normalizeSingleIp(req.socket?.remoteAddress)
    || ''
  )
}

function readCookieValue(req, name) {
  const cookieHeader = String(req.headers.cookie || '')
  if (!cookieHeader) return ''

  const prefix = `${name}=`
  const pair = cookieHeader
    .split(';')
    .map((item) => item.trim())
    .find((item) => item.startsWith(prefix))

  if (!pair) return ''

  try {
    return decodeURIComponent(pair.slice(prefix.length))
  } catch {
    return pair.slice(prefix.length)
  }
}

function normalizeVisitorId(value) {
  const visitorId = cleanText(value, 200)

  if (!visitorId) return ''
  if (!/^[a-zA-Z0-9._:-]{6,200}$/.test(visitorId)) return ''

  return visitorId
}

function getVisitorId(req) {
  return normalizeVisitorId(
    req.headers['x-shadow-visitor-id']
      || req.headers['x-visitor-id']
      || req.query?.visitor_id
      || readCookieValue(req, 'shadow_visitor_id')
      || readCookieValue(req, 'shadowVisitorId')
  )
}

function buildIpsIdentity(req) {
  const accountId = cleanText(
    req.user?.user_id
      || req.user?.admin_id
      || req.user?.id,
    200
  )
  const visitorId = getVisitorId(req)
  const ipAddress = getClientIp(req)

  const identityKey = accountId
    ? `account:${accountId}`
    : visitorId
      ? `visitor:${visitorId}`
      : ipAddress
        ? `ip:${ipAddress}`
        : ''

  return {
    identityKey,
    identityType: accountId
      ? 'account'
      : visitorId
        ? 'visitor'
        : ipAddress
          ? 'ip'
          : 'unknown',
    accountId,
    visitorId,
    ipAddress,
  }
}

function buildIpFallbackIdentity(identity) {
  if (!identity.ipAddress || identity.identityType === 'ip') return null

  return {
    identityKey: `ip:${identity.ipAddress}`,
    identityType: 'ip_fallback',
    accountId: '',
    visitorId: '',
    ipAddress: identity.ipAddress,
  }
}

function normalizePath(req) {
  const raw = String(req.originalUrl || req.url || req.path || '/')
    .split('?')[0]
    .slice(0, 500)

  return raw
    .split('/')
    .map((segment) => {
      if (!segment) return segment
      if (/^\d+$/.test(segment)) return ':id'
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(segment)) return ':id'
      if (/^[0-9a-f]{16,}$/i.test(segment)) return ':id'
      if (/^[A-Za-z0-9_-]{32,}$/.test(segment)) return ':id'
      return segment.slice(0, 100)
    })
    .join('/') || '/'
}

function requestSource(req, path) {
  const candidate = String(req.headers.origin || req.headers.referer || '').trim()

  if (candidate) {
    try {
      const hostname = new URL(candidate).hostname.toLowerCase()

      if (hostname === 'admin.shadowerabook.site') return 'ADMIN'
      if (
        hostname === 'shadowerabook.site'
        || hostname === 'www.shadowerabook.site'
      ) {
        return 'WEB'
      }

      if (hostname === 'localhost' || hostname === '127.0.0.1') {
        return path.startsWith('/api/admin/') ? 'ADMIN' : 'WEB'
      }

      return 'UNKNOWN'
    } catch {
      return 'UNKNOWN'
    }
  }

  if (path.startsWith('/api/admin/')) return 'ADMIN'
  if (path.startsWith('/api/')) return 'BACKEND'
  return 'UNKNOWN'
}

function shouldSkip(method, path) {
  if (method === 'OPTIONS') return true
  if (path === '/' || path === '/favicon.ico') return true
  if (path === '/health' || path.startsWith('/health/')) return true
  if (path === '/api/admin/work' || path.startsWith('/api/admin/work/')) return true
  return false
}

function createBaseTracker({ key, source, method, path, now }) {
  return {
    key,
    source,
    method,
    path,
    state: 'normal',
    windowCount: 0,
    lastWindowCount: 0,
    baselineCount: 0,
    suspiciousWindows: 0,
    recoveryWindows: 0,
    peakPerMinute: 0,
    peakWindowCount: 0,
    firstSeenAt: now,
    lastSeenAt: now,
    detectedAt: null,
    resolvedAt: null,
  }
}

function evictOldestSafe(map) {
  let oldestKey = ''
  let oldestSeen = Infinity

  for (const [key, item] of map.entries()) {
    if (item.state === 'active' || item.state === 'suspect') continue

    if (item.lastSeenAt < oldestSeen) {
      oldestSeen = item.lastSeenAt
      oldestKey = key
    }
  }

  if (!oldestKey) return false

  map.delete(oldestKey)
  return true
}

function getRouteTracker({ key, source, method, path, now }) {
  let item = routeTrackers.get(key)
  if (item) return item

  if (
    routeTrackers.size >= MAX_ROUTE_TRACKED_KEYS
    && !evictOldestSafe(routeTrackers)
  ) {
    return null
  }

  item = createBaseTracker({
    key,
    source,
    method,
    path,
    now,
  })

  routeTrackers.set(key, item)
  return item
}

function getIdentityTracker({
  key,
  source,
  method,
  path,
  identity,
  thresholdMultiplier,
  now,
}) {
  let item = identityTrackers.get(key)
  if (item) return item

  if (
    identityTrackers.size >= MAX_IDENTITY_TRACKED_KEYS
    && !evictOldestSafe(identityTrackers)
  ) {
    return null
  }

  item = {
    ...createBaseTracker({
      key,
      source,
      method,
      path,
      now,
    }),
    identityKey: identity.identityKey,
    identityType: identity.identityType,
    accountId: identity.accountId,
    visitorId: identity.visitorId,
    ipAddress: identity.ipAddress,
    thresholdMultiplier,
  }

  identityTrackers.set(key, item)
  return item
}

function ratePerMinute(count) {
  return Math.round(count * (60000 / ANALYZE_INTERVAL_MS))
}

function thresholdsFor(item) {
  const multiplier = Math.max(1, Number(item.thresholdMultiplier) || 1)

  return {
    minRising: MIN_RISING_COUNT * multiplier,
    newSignal: NEW_SIGNAL_COUNT * multiplier,
    sustainedHigh: SUSTAINED_HIGH_COUNT * multiplier,
    immediate: IMMEDIATE_ACTIVE_COUNT * multiplier,
    isolate: ISOLATE_COUNT * multiplier,
    recoverySafe: RECOVERY_SAFE_COUNT * multiplier,
  }
}

function incidentData(item, now = Date.now()) {
  return {
    source: item.source,
    method: item.method,
    path: item.path,
    peakRequestsPerMinute: item.peakPerMinute,
    detectedAt: item.detectedAt
      ? new Date(item.detectedAt).toISOString()
      : new Date(now).toISOString(),
    lastDetectedAt: new Date(now).toISOString(),
  }
}

function realtimeIncident(item, now, count) {
  return {
    source: item.source,
    method: item.method,
    path: item.path,
    status: item.state,
    estimated_requests_per_minute: ratePerMinute(count),
    peak_requests_per_minute: item.peakPerMinute,
    detected_at: item.detectedAt
      ? new Date(item.detectedAt).toISOString()
      : null,
    resolved_at: item.resolvedAt
      ? new Date(item.resolvedAt).toISOString()
      : null,
    last_seen_at: new Date(now).toISOString(),
  }
}

function ipsIncident(item, now, count) {
  return {
    ...realtimeIncident(item, now, count),
    identity_key: item.identityKey,
    identity_type: item.identityType,
    account_id: item.accountId || null,
    visitor_id: item.visitorId || null,
    ip_address: item.ipAddress || null,
  }
}

function routeEmit(event, item, count, baseline) {
  console.warn(
    event,
    JSON.stringify({
      source: item.source,
      method: item.method,
      path: item.path,
      state: item.state,
      window_requests: count,
      estimated_requests_per_minute: ratePerMinute(count),
      baseline_window_requests: Number(baseline.toFixed(1)),
      peak_requests_per_minute: item.peakPerMinute,
      detected_at: item.detectedAt
        ? new Date(item.detectedAt).toISOString()
        : null,
      resolved_at: item.resolvedAt
        ? new Date(item.resolvedAt).toISOString()
        : null,
    })
  )
}

function defenseAction(item) {
  const thresholds = thresholdsFor(item)
  const peak = item.peakWindowCount

  if (peak >= thresholds.isolate) return 'isolate'
  if (peak >= thresholds.immediate) return 'block'
  return 'restrict'
}

function suspiciousState(item, count, baseline) {
  const thresholds = thresholdsFor(item)

  const newBurst =
    baseline < 5 * (item.thresholdMultiplier || 1)
    && count >= thresholds.newSignal

  const rising =
    baseline >= 5 * (item.thresholdMultiplier || 1)
    && count >= thresholds.minRising
    && count >= baseline * RISING_FACTOR

  const sustainedHigh = count >= thresholds.sustainedHigh
  const immediate = count >= thresholds.immediate

  return {
    suspicious: newBurst || rising || sustainedHigh || immediate,
    immediate,
    recoverySafe: thresholds.recoverySafe,
  }
}

function activateRoute(
  item,
  now,
  count,
  baseline,
  event = 'WORK_LOOP_ACTIVE'
) {
  item.state = 'active'
  item.detectedAt = item.detectedAt || now
  item.resolvedAt = null
  item.recoveryWindows = 0
  item.suspiciousWindows = ACTIVE_WINDOWS_REQUIRED
  item.peakPerMinute = Math.max(
    item.peakPerMinute,
    ratePerMinute(count)
  )
  item.peakWindowCount = Math.max(item.peakWindowCount, count)

  routeEmit(event, item, count, baseline)

  const severity = count >= IMMEDIATE_ACTIVE_COUNT
    ? 'critical'
    : 'high'

  reportGuardState({
    guard: 'worker',
    state: 'defending',
    reason: 'Active route incident detected',
    details: {
      source: item.source,
      method: item.method,
      path: item.path,
      estimated_requests_per_minute: ratePerMinute(count),
      peak_requests_per_minute: item.peakPerMinute,
    },
    severity,
  })

  publishSecurityEvent({
    source: 'worker',
    target: 'all',
    type: event === 'WORK_LOOP_REOPENED'
      ? 'route_incident_reopened'
      : 'route_incident_active',
    severity,
    payload: {
      source: item.source,
      method: item.method,
      path: item.path,
      estimated_requests_per_minute: ratePerMinute(count),
      peak_requests_per_minute: item.peakPerMinute,
    },
  })

  void recordWorkIncidentActive(incidentData(item, now))

  publishWorkRealtimeEvent(
    event === 'WORK_LOOP_REOPENED' ? 'reopened' : 'active',
    realtimeIncident(item, now, count)
  )
}

function activateIdentity(item, now, count) {
  item.state = 'active'
  item.detectedAt = item.detectedAt || now
  item.resolvedAt = null
  item.recoveryWindows = 0
  item.suspiciousWindows = ACTIVE_WINDOWS_REQUIRED
  item.peakPerMinute = Math.max(
    item.peakPerMinute,
    ratePerMinute(count)
  )
  item.peakWindowCount = Math.max(item.peakWindowCount, count)

  defendIps(
    ipsIncident(item, now, count),
    defenseAction(item)
  )
}

function analyzeRouteTracker(item, now) {
  const count = item.windowCount
  const baseline = item.baselineCount
  const currentRate = ratePerMinute(count)
  const state = suspiciousState(item, count, baseline)

  item.lastWindowCount = count
  item.peakPerMinute = Math.max(item.peakPerMinute, currentRate)
  item.peakWindowCount = Math.max(item.peakWindowCount, count)

  if (item.state === 'normal') {
    if (state.immediate) {
      activateRoute(item, now, count, baseline)
    } else if (state.suspicious) {
      item.state = 'suspect'
      item.suspiciousWindows = 1
      item.detectedAt = now
      routeEmit('WORK_LOOP_SUSPECT', item, count, baseline)
    }
  } else if (item.state === 'suspect') {
    if (state.suspicious) {
      item.suspiciousWindows += 1

      if (
        state.immediate
        || item.suspiciousWindows >= ACTIVE_WINDOWS_REQUIRED
      ) {
        activateRoute(item, now, count, baseline)
      }
    } else {
      item.state = 'normal'
      item.suspiciousWindows = 0
      item.detectedAt = null
      item.peakPerMinute = 0
      item.peakWindowCount = 0
    }
  } else if (item.state === 'active') {
    if (count <= state.recoverySafe) {
      item.recoveryWindows += 1

      if (item.recoveryWindows >= RECOVERY_WINDOWS_REQUIRED) {
        item.state = 'resolved'
        item.resolvedAt = now

        routeEmit('WORK_LOOP_RESOLVED', item, count, baseline)

        void recordWorkIncidentResolved({
          source: item.source,
          method: item.method,
          path: item.path,
          resolvedAt: new Date(now).toISOString(),
          peakRequestsPerMinute: item.peakPerMinute,
        })

        publishWorkRealtimeEvent(
          'resolved',
          realtimeIncident(item, now, count)
        )

        publishSecurityEvent({
          source: 'worker',
          target: 'all',
          type: 'route_incident_resolved',
          severity: 'info',
          payload: {
            source: item.source,
            method: item.method,
            path: item.path,
            peak_requests_per_minute: item.peakPerMinute,
          },
        })

        const hasActiveRoute = [...routeTrackers.values()]
          .some((entry) => entry.state === 'active')

        if (!hasActiveRoute) {
          reportGuardState({
            guard: 'worker',
            state: 'monitoring',
            reason: 'No active route incidents',
            severity: 'info',
          })
        }
      }
    } else {
      item.recoveryWindows = 0
    }
  } else if (item.state === 'resolved' && state.suspicious) {
    item.detectedAt = now
    item.peakWindowCount = count

    activateRoute(
      item,
      now,
      count,
      baseline,
      'WORK_LOOP_REOPENED'
    )
  }

  item.baselineCount = baseline === 0
    ? count
    : baseline * 0.75 + count * 0.25

  item.windowCount = 0
}

function analyzeIdentityTracker(item, now) {
  const count = item.windowCount
  const baseline = item.baselineCount
  const currentRate = ratePerMinute(count)
  const state = suspiciousState(item, count, baseline)

  item.lastWindowCount = count
  item.peakPerMinute = Math.max(item.peakPerMinute, currentRate)
  item.peakWindowCount = Math.max(item.peakWindowCount, count)

  if (item.state === 'normal') {
    if (state.immediate) {
      activateIdentity(item, now, count)
    } else if (state.suspicious) {
      item.state = 'suspect'
      item.suspiciousWindows = 1
      item.detectedAt = now
    }
  } else if (item.state === 'suspect') {
    if (state.suspicious) {
      item.suspiciousWindows += 1

      if (
        state.immediate
        || item.suspiciousWindows >= ACTIVE_WINDOWS_REQUIRED
      ) {
        activateIdentity(item, now, count)
      }
    } else {
      item.state = 'normal'
      item.suspiciousWindows = 0
      item.detectedAt = null
      item.peakPerMinute = 0
      item.peakWindowCount = 0
    }
  } else if (item.state === 'active') {
    if (count <= state.recoverySafe) {
      item.recoveryWindows += 1

      if (item.recoveryWindows >= RECOVERY_WINDOWS_REQUIRED) {
        item.state = 'resolved'
        item.resolvedAt = now
        releaseIps(ipsIncident(item, now, count))
      }
    } else {
      item.recoveryWindows = 0

      defendIps(
        ipsIncident(item, now, count),
        defenseAction(item)
      )
    }
  } else if (item.state === 'resolved' && state.suspicious) {
    item.detectedAt = now
    item.peakWindowCount = count
    activateIdentity(item, now, count)
  }

  item.baselineCount = baseline === 0
    ? count
    : baseline * 0.75 + count * 0.25

  item.windowCount = 0
}

function cleanupTrackerMap(map, now) {
  for (const [key, item] of map.entries()) {
    if (
      item.state === 'resolved'
      && item.resolvedAt
      && now - item.resolvedAt >= RESOLVED_TTL_MS
    ) {
      map.delete(key)
      continue
    }

    if (
      item.state === 'normal'
      && now - item.lastSeenAt >= ENTRY_IDLE_TTL_MS
    ) {
      map.delete(key)
    }
  }
}

function analyzeAll() {
  const now = Date.now()

  for (const item of routeTrackers.values()) {
    analyzeRouteTracker(item, now)
  }

  for (const item of identityTrackers.values()) {
    analyzeIdentityTracker(item, now)
  }

  cleanupTrackerMap(routeTrackers, now)
  cleanupTrackerMap(identityTrackers, now)
}

function trackRequest(item, now, immediateThreshold, activate) {
  if (!item) return

  item.windowCount += 1
  item.lastSeenAt = now

  if (
    item.state !== 'active'
    && item.windowCount === immediateThreshold
  ) {
    activate(item, now, item.windowCount, item.baselineCount)
  }
}

export function workDetector(req, res, next) {
  if (!enabled) return next()

  try {
    const method = String(req.method || 'UNKNOWN').toUpperCase()
    const path = normalizePath(req)

    if (shouldSkip(method, path)) return next()

    const source = requestSource(req, path)
    const identity = buildIpsIdentity(req)
    const now = Date.now()

    const routeKey = `${source}|${method}|${path}`
    const routeItem = getRouteTracker({
      key: routeKey,
      source,
      method,
      path,
      now,
    })

    trackRequest(
      routeItem,
      now,
      IMMEDIATE_ACTIVE_COUNT,
      (item, at, count, baseline) =>
        activateRoute(item, at, count, baseline)
    )

    if (identity.identityKey) {
      const identityKey =
        `${identity.identityKey}|${source}|${method}|${path}`

      const identityItem = getIdentityTracker({
        key: identityKey,
        source,
        method,
        path,
        identity,
        thresholdMultiplier: 1,
        now,
      })

      trackRequest(
        identityItem,
        now,
        IMMEDIATE_ACTIVE_COUNT,
        (item, at, count) =>
          activateIdentity(item, at, count)
      )
    }

    const ipFallbackIdentity = buildIpFallbackIdentity(identity)

    if (ipFallbackIdentity) {
      const fallbackKey =
        `${ipFallbackIdentity.identityKey}|${source}|${method}|${path}`

      const fallbackItem = getIdentityTracker({
        key: fallbackKey,
        source,
        method,
        path,
        identity: ipFallbackIdentity,
        thresholdMultiplier: IP_FALLBACK_MULTIPLIER,
        now,
      })

      trackRequest(
        fallbackItem,
        now,
        IMMEDIATE_ACTIVE_COUNT * IP_FALLBACK_MULTIPLIER,
        (item, at, count) =>
          activateIdentity(item, at, count)
      )
    }
  } catch (error) {
    console.error(
      'WORK_DETECTOR_ERROR:',
      error?.message || error
    )
  }

  return next()
}

export function startWorkDetectorMonitor() {
  if (monitorTimer) return monitorTimer

  enabled = String(
    process.env.WORK_DETECTOR_ENABLED ?? 'true'
  )
    .trim()
    .toLowerCase() !== 'false'

  if (!enabled) {
    reportGuardState({
      guard: 'worker',
      state: 'offline',
      reason: 'Worker detector disabled',
      severity: 'low',
    })

    console.log('WORK_DETECTOR: disabled')
    return null
  }

  startWorkIncidentCleanup()

  monitorTimer = setInterval(
    analyzeAll,
    ANALYZE_INTERVAL_MS
  )

  monitorTimer.unref?.()

  reportGuardState({
    guard: 'worker',
    state: 'monitoring',
    reason: 'Worker detector ready',
    details: {
      analyze_interval_ms: ANALYZE_INTERVAL_MS,
      route_tracker_limit: MAX_ROUTE_TRACKED_KEYS,
      identity_tracker_limit: MAX_IDENTITY_TRACKED_KEYS,
    },
    severity: 'info',
  })

  console.log(
    'WORK_DETECTOR: route + identity defense enabled'
  )

  return monitorTimer
}

export function getWorkDetectorSnapshot() {
  return [...routeTrackers.values()]
    .filter((item) => item.state !== 'normal')
    .map((item) => ({
      source: item.source,
      method: item.method,
      path: item.path,
      state: item.state,
      last_window_requests: item.lastWindowCount,
      estimated_requests_per_minute:
        ratePerMinute(item.lastWindowCount),
      peak_requests_per_minute: item.peakPerMinute,
      detected_at: item.detectedAt
        ? new Date(item.detectedAt).toISOString()
        : null,
      resolved_at: item.resolvedAt
        ? new Date(item.resolvedAt).toISOString()
        : null,
      last_seen_at:
        new Date(item.lastSeenAt).toISOString(),
    }))
    .sort((a, b) => {
      const rank = {
        active: 0,
        suspect: 1,
        resolved: 2,
      }

      return (
        (rank[a.state] ?? 9)
        - (rank[b.state] ?? 9)
      )
    })
}
