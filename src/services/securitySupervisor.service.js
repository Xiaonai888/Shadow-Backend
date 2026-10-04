import {
  enterSecuritySafeMode,
  getSecurityControlSnapshot,
  publishSecurityEvent,
  reportGuardState,
  subscribeSecurityEvents,
} from './securityControlPlane.service.js'

const CHECK_INTERVAL_MS = 15000
const STARTUP_GRACE_MS = 60000
const SIGNAL_TTL_MS = 5 * 60 * 1000

const expectedGuards = new Set([
  'worker',
  'ips',
  'spam_guard',
  'kill_switch',
  'security_gate',
  'tamper_guard',
  'security_response_assistant',
  'control_plane',
])

const failureStates = new Set([
  'offline',
  'degraded',
  'critical',
])

let timer = null
let unsubscribe = null
let startedAt = 0
let lastFingerprint = ''
let rejectedSignals = []

function cleanText(value, maxLength = 500) {
  return String(value || '').trim().slice(0, maxLength)
}

function pruneSignals(now = Date.now()) {
  rejectedSignals = rejectedSignals.filter(
    (item) => now - item.created_at <= SIGNAL_TTL_MS
  )
}

function reportSupervisor(state, reason, details = {}, severity = 'info') {
  reportGuardState({
    guard: 'security_supervisor',
    state,
    reason,
    details,
    severity,
  })
}

function anomalyFingerprint(details) {
  return JSON.stringify({
    missing: details.missing,
    unhealthy: details.unhealthy,
    unexpected: details.unexpected,
    rejected: details.rejected_guard_reports,
  })
}

function evaluateSecurityGuards() {
  const now = Date.now()
  pruneSignals(now)

  const snapshot = getSecurityControlSnapshot()
  const guards = new Map(
    snapshot.guards.map((item) => [item.guard, item])
  )

  const missing = [...expectedGuards].filter(
    (guard) => !guards.has(guard)
  )

  const unhealthy = [...expectedGuards]
    .map((guard) => guards.get(guard))
    .filter((item) => item && failureStates.has(item.state))
    .map((item) => ({
      guard: item.guard,
      state: item.state,
      reason: item.reason || null,
    }))

  const unexpected = snapshot.guards
    .filter((item) => (
      item.guard !== 'security_supervisor'
      && item.guard !== 'control_plane'
      && !expectedGuards.has(item.guard)
    ))
    .map((item) => ({
      guard: item.guard,
      state: item.state,
    }))

  const details = {
    expected_total: expectedGuards.size + 1,
    detected_total:
      [...expectedGuards].filter((guard) => guards.has(guard)).length + 1,
    missing,
    unhealthy,
    unexpected,
    rejected_guard_reports: rejectedSignals.map((item) => ({
      guard: item.guard,
      state: item.state,
      created_at: item.created_at,
    })),
  }

  const startupGrace = now - startedAt < STARTUP_GRACE_MS
  const anomaly =
    !startupGrace
    && (
      missing.length > 0
      || unhealthy.length > 0
      || unexpected.length > 0
      || rejectedSignals.length > 0
    )

  if (!anomaly) {
    reportSupervisor(
      startupGrace ? 'awake' : 'monitoring',
      startupGrace
        ? 'Security Supervisor waiting for all guards to initialize'
        : 'Security Supervisor verified all expected guards',
      details,
      'info'
    )

    if (!startupGrace) lastFingerprint = ''
    return details
  }

  const fingerprint = anomalyFingerprint(details)

  reportSupervisor(
    'critical',
    'Security Supervisor detected a guard integrity anomaly',
    details,
    'critical'
  )

  if (snapshot.control.mode !== 'safe_mode') {
    enterSecuritySafeMode({
      source: 'security_supervisor',
      reason: 'Security Supervisor detected a guard integrity anomaly',
      severity: 'critical',
    })
  }

  if (fingerprint !== lastFingerprint) {
    lastFingerprint = fingerprint

    publishSecurityEvent({
      source: 'security_supervisor',
      target: 'all',
      type: 'security_supervisor_anomaly',
      severity: 'critical',
      payload: details,
    })
  }

  return details
}

function handleSecurityEvent(event) {
  if (
    cleanText(event?.type, 80).toLowerCase()
    !== 'unregistered_guard_report'
  ) {
    return
  }

  const payload =
    event?.payload && typeof event.payload === 'object'
      ? event.payload
      : {}

  rejectedSignals.push({
    guard: cleanText(payload.requested_guard, 50) || 'unknown',
    state: cleanText(payload.requested_state, 40) || 'unknown',
    created_at: Date.now(),
  })

  evaluateSecurityGuards()
}

export function startSecuritySupervisor() {
  if (timer) {
    return {
      started: true,
      already_started: true,
    }
  }

  startedAt = Date.now()
  unsubscribe = subscribeSecurityEvents(handleSecurityEvent)

  reportSupervisor(
    'awake',
    'Security Supervisor started',
    {
      expected_total: expectedGuards.size + 1,
    },
    'info'
  )

  evaluateSecurityGuards()

  timer = setInterval(
    evaluateSecurityGuards,
    CHECK_INTERVAL_MS
  )

  timer.unref?.()

  return {
    started: true,
    already_started: false,
  }
}

export function stopSecuritySupervisor() {
  if (timer) {
    clearInterval(timer)
    timer = null
  }

  if (unsubscribe) {
    unsubscribe()
    unsubscribe = null
  }

  reportSupervisor(
    'offline',
    'Security Supervisor stopped',
    {},
    'high'
  )

  return true
}

export function getSecuritySupervisorSnapshot() {
  return {
    started: Boolean(timer),
    expected_total: expectedGuards.size + 1,
    expected_guards: [
      ...expectedGuards,
      'security_supervisor',
    ],
    recent_rejected_guard_reports: [...rejectedSignals],
    last_check: evaluateSecurityGuards(),
  }
}
