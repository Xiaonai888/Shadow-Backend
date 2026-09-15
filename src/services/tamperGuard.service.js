import { randomUUID } from 'node:crypto'
import {
  enterSecuritySafeMode,
  isSecuritySafeMode,
  publishSecurityEvent,
  reportGuardState,
} from './securityControlPlane.service.js'

const MAX_ACTIVE_INCIDENTS = 250
const EVENT_THROTTLE_MS = 60 * 1000

const protectedTargets = new Set([
  'worker',
  'ips',
  'spam_guard',
  'kill_switch',
  'security_gate',
  'tamper_guard',
  'control_plane',
  'security_config',
])

const weakeningActions = new Set([
  'disable',
  'bypass',
  'release',
  'unblock',
  'restore_normal',
  'weaken',
  'remove',
  'override',
  'replace',
  'config_change',
])

const activeIncidents = new Map()
const lastEventAt = new Map()

let lastReportedState = ''
let lastReportedCount = -1

function cleanText(value, maxLength = 500) {
  return String(value || '').trim().slice(0, maxLength)
}

function safeObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return { ...value }
}

function normalizeTarget(value) {
  return cleanText(value, 80).toLowerCase()
}

function normalizeAction(value) {
  return cleanText(value, 80).toLowerCase()
}

function incidentKey({ target, action, actor }) {
  return [
    normalizeTarget(target),
    normalizeAction(action),
    cleanText(actor, 200).toLowerCase() || 'unknown',
  ].join('|')
}

function evictOldestIncident() {
  let oldestKey = ''
  let oldestAt = Infinity

  for (const [key, item] of activeIncidents.entries()) {
    if (item.last_seen_at < oldestAt) {
      oldestAt = item.last_seen_at
      oldestKey = key
    }
  }

  if (oldestKey) {
    activeIncidents.delete(oldestKey)
    lastEventAt.delete(oldestKey)
  }
}

function reportTamperState(reason, severity = 'info', force = false) {
  const count = activeIncidents.size
  const state = count > 0 ? 'critical' : 'sleeping'

  if (
    !force
    && state === lastReportedState
    && count === lastReportedCount
  ) {
    return
  }

  lastReportedState = state
  lastReportedCount = count

  reportGuardState({
    guard: 'tamper_guard',
    state,
    reason,
    details: {
      active_incidents: count,
    },
    severity,
  })
}

function shouldPublishIncident(key) {
  const now = Date.now()
  const previous = lastEventAt.get(key) || 0

  if (now - previous < EVENT_THROTTLE_MS) {
    return false
  }

  lastEventAt.set(key, now)
  return true
}

function recordIncident({
  target,
  action,
  actor,
  reason,
  details,
  code,
  rootEventId,
  parentEventId,
  hopCount,
}) {
  const now = Date.now()
  const key = incidentKey({ target, action, actor })
  let incident = activeIncidents.get(key)

  if (!incident) {
    if (activeIncidents.size >= MAX_ACTIVE_INCIDENTS) {
      evictOldestIncident()
    }

    incident = {
      id: randomUUID(),
      key,
      target,
      action,
      actor: actor || 'unknown',
      code,
      reason,
      count: 0,
      first_seen_at: now,
      last_seen_at: now,
      details: safeObject(details),
    }

    activeIncidents.set(key, incident)
  }

  incident.count += 1
  incident.last_seen_at = now
  incident.reason = reason
  incident.details = safeObject(details)

  if (shouldPublishIncident(key)) {
    publishSecurityEvent({
      root_event_id: cleanText(rootEventId, 100) || undefined,
      parent_event_id: cleanText(parentEventId, 100) || undefined,
      hop_count: Math.max(0, Math.round(Number(hopCount) || 0)),
      source: 'tamper_guard',
      target: 'all',
      type: 'tamper_attempt_detected',
      severity: 'critical',
      payload: {
        incident_id: incident.id,
        target,
        action,
        actor: incident.actor,
        code,
        reason,
        count: incident.count,
        details: safeObject(details),
      },
    })
  }

  if (!isSecuritySafeMode()) {
    enterSecuritySafeMode({
      source: 'tamper_guard',
      reason: `Tamper Guard: ${reason}`,
      severity: 'critical',
    })
  }

  reportTamperState(reason, 'critical', true)

  return { ...incident, details: safeObject(incident.details) }
}

export function guardSecurityMutation({
  target,
  action,
  actor = '',
  authorized = false,
  allowInSafeMode = false,
  reason = '',
  details = {},
  rootEventId = '',
  parentEventId = '',
  hopCount = 0,
} = {}) {
  const safeTarget = normalizeTarget(target)
  const safeAction = normalizeAction(action)
  const safeActor = cleanText(actor, 200) || 'unknown'
  const safeReason = cleanText(reason, 500)

  if (!protectedTargets.has(safeTarget)) {
    return {
      ok: true,
      guarded: false,
      code: 'TAMPER_TARGET_NOT_PROTECTED',
    }
  }

  if (!safeAction) {
    return {
      ok: false,
      guarded: true,
      code: 'TAMPER_ACTION_REQUIRED',
    }
  }

  if (!authorized) {
    const incident = recordIncident({
      target: safeTarget,
      action: safeAction,
      actor: safeActor,
      reason: safeReason || 'Unauthorized security control mutation',
      details,
      code: 'SECURITY_TAMPER_UNAUTHORIZED',
      rootEventId,
      parentEventId,
      hopCount,
    })

    return {
      ok: false,
      guarded: true,
      code: 'SECURITY_TAMPER_UNAUTHORIZED',
      incident,
    }
  }

  if (
    isSecuritySafeMode()
    && weakeningActions.has(safeAction)
    && !allowInSafeMode
  ) {
    const incident = recordIncident({
      target: safeTarget,
      action: safeAction,
      actor: safeActor,
      reason: safeReason || 'Security weakening blocked during safe mode',
      details,
      code: 'SECURITY_TAMPER_SAFE_MODE_BLOCKED',
      rootEventId,
      parentEventId,
      hopCount,
    })

    return {
      ok: false,
      guarded: true,
      code: 'SECURITY_TAMPER_SAFE_MODE_BLOCKED',
      incident,
    }
  }

  return {
    ok: true,
    guarded: true,
    code: 'SECURITY_MUTATION_ALLOWED',
  }
}

export function resolveTamperIncident({
  incidentId,
  actor = '',
  reason = 'Tamper incident resolved',
} = {}) {
  const safeId = cleanText(incidentId, 100)
  if (!safeId) return false

  let resolvedKey = ''
  let resolved = null

  for (const [key, incident] of activeIncidents.entries()) {
    if (incident.id !== safeId) continue
    resolvedKey = key
    resolved = incident
    break
  }

  if (!resolvedKey || !resolved) return false

  activeIncidents.delete(resolvedKey)
  lastEventAt.delete(resolvedKey)

  publishSecurityEvent({
    source: 'tamper_guard',
    target: 'control_plane',
    type: 'tamper_incident_resolved',
    severity: 'info',
    payload: {
      incident_id: resolved.id,
      target: resolved.target,
      action: resolved.action,
      resolved_by: cleanText(actor, 200) || 'system',
      reason: cleanText(reason, 500) || 'Tamper incident resolved',
    },
  })

  reportTamperState(
    activeIncidents.size > 0
      ? 'Tamper Guard still has active incidents'
      : 'Tamper Guard sleeping; no active incidents',
    activeIncidents.size > 0 ? 'high' : 'info',
    true
  )

  return true
}

export function getTamperGuardSnapshot() {
  return {
    state: activeIncidents.size > 0 ? 'critical' : 'sleeping',
    active_count: activeIncidents.size,
    protected_targets: [...protectedTargets],
    active_incidents: [...activeIncidents.values()].map((item) => ({
      ...item,
      details: safeObject(item.details),
    })),
  }
}

reportTamperState('Tamper Guard sleeping; no active incidents', 'info', true)
