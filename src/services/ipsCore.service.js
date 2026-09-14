import {
  publishSecurityEvent,
  reportGuardState,
} from './securityControlPlane.service.js'

const MAX_ACTIVE_INCIDENTS = 500

const activeIncidents = new Map()
const allowedActions = new Set([
  'watch',
  'restrict',
  'block',
  'isolate',
])

const actionRank = {
  watch: 0,
  restrict: 1,
  block: 2,
  isolate: 3,
}

let lastReportedState = ''
let lastReportedAction = ''
let lastReportedCount = -1

function cleanText(value, maxLength = 500) {
  return String(value || '').trim().slice(0, maxLength)
}

function normalizeSource(value) {
  const source = cleanText(value, 20).toUpperCase()

  return ['WEB', 'ADMIN', 'BACKEND', 'UNKNOWN'].includes(source)
    ? source
    : 'UNKNOWN'
}

function normalizeMethod(value) {
  return cleanText(value, 16).toUpperCase() || 'UNKNOWN'
}

function normalizePath(value) {
  const raw = cleanText(value, 500) || '/'

  return raw
    .split('?')[0]
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

function normalizeIdentityKey(incident = {}) {
  const direct = cleanText(incident.identity_key, 250)
  if (direct) return direct

  const accountId = cleanText(incident.account_id, 200)
  if (accountId) return `account:${accountId}`

  const visitorId = cleanText(incident.visitor_id, 200)
  if (visitorId) return `visitor:${visitorId}`

  const ipAddress = cleanText(incident.ip_address, 150)
  if (ipAddress) return `ip:${ipAddress}`

  return 'unknown'
}

function fingerprintOf(incident = {}) {
  return [
    normalizeIdentityKey(incident),
    normalizeSource(incident.source),
    normalizeMethod(incident.method),
    normalizePath(incident.path),
  ].join('|')
}

function safeNumber(value) {
  return Math.max(0, Math.round(Number(value) || 0))
}

function cloneIncident(item) {
  return item ? { ...item } : null
}

function strongestDefense() {
  let strongestAction = 'watch'

  for (const item of activeIncidents.values()) {
    const action = allowedActions.has(item.action)
      ? item.action
      : 'watch'

    if (
      (actionRank[action] || 0)
      > (actionRank[strongestAction] || 0)
    ) {
      strongestAction = action
    }
  }

  const state = activeIncidents.size === 0
    ? 'sleeping'
    : strongestAction === 'isolate'
      ? 'isolated'
      : strongestAction === 'block'
        ? 'blocked'
        : strongestAction === 'restrict'
          ? 'defending'
          : 'awake'

  return {
    state,
    action: activeIncidents.size === 0
      ? 'none'
      : strongestAction,
  }
}

function reportIpsState(reason, severity = 'info', force = false) {
  const strongest = strongestDefense()
  const count = activeIncidents.size

  if (
    !force
    && strongest.state === lastReportedState
    && strongest.action === lastReportedAction
    && count === lastReportedCount
  ) {
    return
  }

  lastReportedState = strongest.state
  lastReportedAction = strongest.action
  lastReportedCount = count

  reportGuardState({
    guard: 'ips',
    state: strongest.state,
    reason,
    details: {
      active_count: count,
      strongest_action: strongest.action,
    },
    severity,
  })
}

function publishIpsEvent({
  type,
  severity,
  item,
  action = null,
} = {}) {
  if (!item) return

  publishSecurityEvent({
    source: 'ips',
    target: 'control_plane',
    type,
    severity,
    payload: {
      fingerprint: item.fingerprint,
      identity_type: item.identity_type,
      source: item.source,
      method: item.method,
      path: item.path,
      action: action || item.action,
      estimated_requests_per_minute:
        item.estimated_requests_per_minute,
      peak_requests_per_minute:
        item.peak_requests_per_minute,
    },
  })
}

function evictOldestIncident() {
  let oldestKey = ''
  let oldestAt = Infinity

  for (const [key, item] of activeIncidents.entries()) {
    if (item.state === 'defending') continue

    if (item.last_signal_at < oldestAt) {
      oldestAt = item.last_signal_at
      oldestKey = key
    }
  }

  if (!oldestKey) {
    for (const [key, item] of activeIncidents.entries()) {
      if (item.last_signal_at < oldestAt) {
        oldestAt = item.last_signal_at
        oldestKey = key
      }
    }
  }

  if (oldestKey) {
    activeIncidents.delete(oldestKey)
  }
}

function upsertAwakeIncident(incident = {}, report = true) {
  const now = Date.now()
  const fingerprint = fingerprintOf(incident)
  let item = activeIncidents.get(fingerprint)
  const isNew = !item

  if (!item) {
    if (activeIncidents.size >= MAX_ACTIVE_INCIDENTS) {
      evictOldestIncident()
    }

    item = {
      fingerprint,
      identity_key: normalizeIdentityKey(incident),
      identity_type:
        cleanText(incident.identity_type, 20) || 'unknown',
      account_id:
        cleanText(incident.account_id, 200) || null,
      visitor_id:
        cleanText(incident.visitor_id, 200) || null,
      ip_address:
        cleanText(incident.ip_address, 150) || null,
      source: normalizeSource(incident.source),
      method: normalizeMethod(incident.method),
      path: normalizePath(incident.path),
      state: 'awake',
      action: 'watch',
      wake_count: 0,
      estimated_requests_per_minute: 0,
      peak_requests_per_minute: 0,
      first_wake_at: now,
      last_signal_at: now,
    }

    activeIncidents.set(fingerprint, item)
  }

  item.state = item.state === 'defending'
    ? 'defending'
    : 'awake'

  item.wake_count += 1
  item.last_signal_at = now

  item.estimated_requests_per_minute = safeNumber(
    incident.estimated_requests_per_minute
  )

  item.peak_requests_per_minute = Math.max(
    item.peak_requests_per_minute,
    safeNumber(incident.peak_requests_per_minute),
    item.estimated_requests_per_minute
  )

  if (report && isNew) {
    publishIpsEvent({
      type: 'ips_awake',
      severity: 'low',
      item,
      action: 'watch',
    })

    reportIpsState('IPS awakened by security signal', 'low')
  }

  return cloneIncident(item)
}

export function findIpsDefense(incident = {}) {
  const item = activeIncidents.get(fingerprintOf(incident))

  if (!item || item.state !== 'defending') {
    return null
  }

  return cloneIncident(item)
}

export function wakeIps(incident = {}) {
  return upsertAwakeIncident(incident, true)
}

export function defendIps(incident = {}, action = 'restrict') {
  const awakened = upsertAwakeIncident(incident, false)
  const item = activeIncidents.get(awakened.fingerprint)
  const previousAction = item.action
  const previousState = item.state
  const normalizedAction = cleanText(action, 20).toLowerCase()

  item.state = 'defending'
  item.action = allowedActions.has(normalizedAction)
    ? normalizedAction
    : 'restrict'

  item.last_signal_at = Date.now()

  const changed =
    previousState !== 'defending'
    || previousAction !== item.action

  if (changed) {
    const escalated =
      (actionRank[item.action] || 0)
      > (actionRank[previousAction] || 0)

    const severity = item.action === 'isolate'
      ? 'critical'
      : item.action === 'block'
        ? 'high'
        : 'medium'

    publishIpsEvent({
      type: escalated
        ? 'ips_defense_escalated'
        : 'ips_defense_started',
      severity,
      item,
    })

    reportIpsState(
      item.action === 'isolate'
        ? 'IPS isolated hostile identity'
        : item.action === 'block'
          ? 'IPS blocked hostile identity'
          : 'IPS defending hostile identity',
      severity,
      true
    )
  }

  return cloneIncident(item)
}

export function releaseIps(incident = {}) {
  const fingerprint = fingerprintOf(incident)
  const item = activeIncidents.get(fingerprint)

  if (!item) return null

  activeIncidents.delete(fingerprint)

  const released = {
    ...item,
    state: 'released',
    released_at: Date.now(),
  }

  publishIpsEvent({
    type: 'ips_defense_released',
    severity: 'info',
    item: released,
  })

  reportIpsState(
    activeIncidents.size === 0
      ? 'IPS sleeping; no active defenses'
      : 'IPS released one defense',
    'info',
    true
  )

  return released
}

export function isIpsSleeping() {
  return activeIncidents.size === 0
}

export function getIpsSnapshot() {
  return {
    state: isIpsSleeping() ? 'sleeping' : 'awake',
    active_count: activeIncidents.size,
    incidents: [...activeIncidents.values()]
      .map(cloneIncident)
      .sort((a, b) => b.last_signal_at - a.last_signal_at),
  }
}

reportIpsState('IPS core ready', 'info', true)
