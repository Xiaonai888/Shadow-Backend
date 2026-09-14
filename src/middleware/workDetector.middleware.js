import {
  recordWorkIncidentActive,
  recordWorkIncidentResolved,
  startWorkIncidentCleanup,
} from '../services/workIncident.service.js'
import { publishWorkRealtimeEvent } from '../services/workRealtime.service.js'
import { wakeIps, releaseIps } from '../services/ipsCore.service.js'

const ANALYZE_INTERVAL_MS = 15000
const ENTRY_IDLE_TTL_MS = 30 * 60 * 1000
const RESOLVED_TTL_MS = 10 * 60 * 1000
const MAX_TRACKED_KEYS = 500
const MIN_RISING_COUNT = 40
const NEW_SIGNAL_COUNT = 75
const SUSTAINED_HIGH_COUNT = 120
const IMMEDIATE_ACTIVE_COUNT = 250
const RISING_FACTOR = 2.5
const ACTIVE_WINDOWS_REQUIRED = 2
const RECOVERY_SAFE_COUNT = 15
const RECOVERY_WINDOWS_REQUIRED = 4

const trackers = new Map()
let monitorTimer = null
let enabled = true

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
      if (hostname === 'shadowerabook.site' || hostname === 'www.shadowerabook.site') return 'WEB'
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

function evictOldest() {
  let oldestKey = ''
  let oldestSeen = Infinity

  for (const [key, item] of trackers.entries()) {
    if (item.lastSeenAt < oldestSeen) {
      oldestSeen = item.lastSeenAt
      oldestKey = key
    }
  }

  if (oldestKey) trackers.delete(oldestKey)
}

function getTracker({ key, source, method, path, now }) {
  let item = trackers.get(key)

  if (!item) {
    if (trackers.size >= MAX_TRACKED_KEYS) evictOldest()

    item = {
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
      firstSeenAt: now,
      lastSeenAt: now,
      detectedAt: null,
      resolvedAt: null,
    }

    trackers.set(key, item)
  }

  return item
}

function ratePerMinute(count) {
  return Math.round(count * (60000 / ANALYZE_INTERVAL_MS))
}

function incidentData(item, now = Date.now()) {
  return {
    source: item.source,
    method: item.method,
    path: item.path,
    peakRequestsPerMinute: item.peakPerMinute,
    detectedAt: item.detectedAt ? new Date(item.detectedAt).toISOString() : new Date(now).toISOString(),
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
    detected_at: item.detectedAt ? new Date(item.detectedAt).toISOString() : null,
    resolved_at: item.resolvedAt ? new Date(item.resolvedAt).toISOString() : null,
    last_seen_at: new Date(now).toISOString(),
  }
}

function emit(event, item, count, baseline) {
  wakeIps(realtimeIncident(item, now, count))
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
      detected_at: item.detectedAt ? new Date(item.detectedAt).toISOString() : null,
      resolved_at: item.resolvedAt ? new Date(item.resolvedAt).toISOString() : null,
    })
  )
}

function activate(item, now, count, baseline, event = 'WORK_LOOP_ACTIVE') {
  item.state = 'active'
  item.detectedAt = item.detectedAt || now
  item.resolvedAt = null
  item.recoveryWindows = 0
  item.suspiciousWindows = ACTIVE_WINDOWS_REQUIRED
  item.peakPerMinute = Math.max(item.peakPerMinute, ratePerMinute(count))
  emit(event, item, count, baseline)
  void recordWorkIncidentActive(incidentData(item, now))

  publishWorkRealtimeEvent(
    event === 'WORK_LOOP_REOPENED' ? 'reopened' : 'active',
    realtimeIncident(item, now, count)
  )
}

function analyzeTracker(item, now) {
  const count = item.windowCount
  const baseline = item.baselineCount
  const currentRate = ratePerMinute(count)

  item.lastWindowCount = count
  item.peakPerMinute = Math.max(item.peakPerMinute, currentRate)

  const newBurst = baseline < 5 && count >= NEW_SIGNAL_COUNT
  const rising = baseline >= 5 && count >= MIN_RISING_COUNT && count >= baseline * RISING_FACTOR
  const sustainedHigh = count >= SUSTAINED_HIGH_COUNT
  const immediate = count >= IMMEDIATE_ACTIVE_COUNT
  const suspicious = newBurst || rising || sustainedHigh || immediate

  if (item.state === 'normal') {
    if (immediate) {
      activate(item, now, count, baseline)
    } else if (suspicious) {
      item.state = 'suspect'
      item.suspiciousWindows = 1
      item.detectedAt = now
      emit('WORK_LOOP_SUSPECT', item, count, baseline)
    }
  } else if (item.state === 'suspect') {
    if (suspicious) {
      item.suspiciousWindows += 1
      if (immediate || item.suspiciousWindows >= ACTIVE_WINDOWS_REQUIRED) {
        activate(item, now, count, baseline)
      }
    } else {
      item.state = 'normal'
      item.suspiciousWindows = 0
      item.detectedAt = null
      item.peakPerMinute = 0
    }
  } else if (item.state === 'active') {
    if (count <= RECOVERY_SAFE_COUNT) {
      item.recoveryWindows += 1

      if (item.recoveryWindows >= RECOVERY_WINDOWS_REQUIRED) {
        item.state = 'resolved'
        item.resolvedAt = now
        emit('WORK_LOOP_RESOLVED', item, count, baseline)
        releaseIps(realtimeIncident(item, now, count))
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
      }
    } else {
      item.recoveryWindows = 0
    }
  } else if (item.state === 'resolved' && suspicious) {
    item.detectedAt = now
    activate(item, now, count, baseline, 'WORK_LOOP_REOPENED')
  }

  item.baselineCount = baseline === 0
    ? count
    : baseline * 0.75 + count * 0.25
  item.windowCount = 0
}

function analyzeAll() {
  const now = Date.now()

  for (const [key, item] of trackers.entries()) {
    analyzeTracker(item, now)

    if (item.state === 'resolved' && item.resolvedAt && now - item.resolvedAt >= RESOLVED_TTL_MS) {
      trackers.delete(key)
      continue
    }

    if (item.state === 'normal' && now - item.lastSeenAt >= ENTRY_IDLE_TTL_MS) {
      trackers.delete(key)
    }
  }
}

export function workDetector(req, res, next) {
  if (!enabled) return next()

  try {
    const method = String(req.method || 'UNKNOWN').toUpperCase()
    const path = normalizePath(req)

    if (shouldSkip(method, path)) return next()

    const source = requestSource(req, path)
    const now = Date.now()
    const key = `${source}|${method}|${path}`
    const item = getTracker({ key, source, method, path, now })

    item.windowCount += 1
    item.lastSeenAt = now

    if (item.state !== 'active' && item.windowCount === IMMEDIATE_ACTIVE_COUNT) {
      activate(item, now, item.windowCount, item.baselineCount)
    }
  } catch (error) {
    console.error('WORK_DETECTOR_ERROR:', error?.message || error)
  }

  return next()
}

export function startWorkDetectorMonitor() {
  if (monitorTimer) return monitorTimer

  enabled = String(process.env.WORK_DETECTOR_ENABLED ?? 'true')
    .trim()
    .toLowerCase() !== 'false'

  if (!enabled) {
    console.log('WORK_DETECTOR: disabled')
    return null
  }

  startWorkIncidentCleanup()

  monitorTimer = setInterval(analyzeAll, ANALYZE_INTERVAL_MS)
  monitorTimer.unref?.()
  console.log('WORK_DETECTOR: observe-only enabled')
  return monitorTimer
}

export function getWorkDetectorSnapshot() {
  return [...trackers.values()]
    .filter((item) => item.state !== 'normal')
    .map((item) => ({
      source: item.source,
      method: item.method,
      path: item.path,
      state: item.state,
      last_window_requests: item.lastWindowCount,
      estimated_requests_per_minute: ratePerMinute(item.lastWindowCount),
      peak_requests_per_minute: item.peakPerMinute,
      detected_at: item.detectedAt ? new Date(item.detectedAt).toISOString() : null,
      resolved_at: item.resolvedAt ? new Date(item.resolvedAt).toISOString() : null,
      last_seen_at: new Date(item.lastSeenAt).toISOString(),
    }))
    .sort((a, b) => {
      const rank = { active: 0, suspect: 1, resolved: 2 }
      return (rank[a.state] ?? 9) - (rank[b.state] ?? 9)
    })
}
