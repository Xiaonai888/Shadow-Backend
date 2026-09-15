import { randomUUID } from 'node:crypto'
import {
  publishSecurityEvent,
  reportGuardState,
  subscribeSecurityEvents,
} from './securityControlPlane.service.js'

const MAX_RESPONSES = 250
const MAX_SEEN_EVENTS = 1000

const triggerTypes = new Set([
  'route_incident_active',
  'route_incident_reopened',
  'tamper_attempt_detected',
  'ips_defense_escalated',
  'spam_guard_blocked',
  'spam_guard_degraded',
  'kill_switch_expiry_failed',
])

const resolutionTypes = new Set([
  'route_incident_resolved',
  'tamper_incident_resolved',
  'ips_defense_released',
  'spam_guard_recovered',
  'kill_switch_released',
  'kill_switch_expired',
])

const responses = new Map()
const activeByKey = new Map()
const seenEventIds = new Set()
const seenEventQueue = []

let unsubscribe = null
let lastReportedState = ''
let lastReportedCount = -1

function cleanText(value, maxLength = 500) {
  return String(value || '').trim().slice(0, maxLength)
}

function safeObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return { ...value }
}

function normalizeSeverity(value) {
  const severity = cleanText(value, 20).toLowerCase()
  return ['high', 'critical'].includes(severity) ? severity : ''
}

function rememberEventId(eventId) {
  const id = cleanText(eventId, 100)
  if (!id || seenEventIds.has(id)) return false

  seenEventIds.add(id)
  seenEventQueue.push(id)

  while (seenEventQueue.length > MAX_SEEN_EVENTS) {
    const oldest = seenEventQueue.shift()
    if (oldest) seenEventIds.delete(oldest)
  }

  return true
}

function responseKey(event) {
  const payload = safeObject(event?.payload)
  const source = cleanText(event?.source, 50).toLowerCase()
  const type = cleanText(event?.type, 80).toLowerCase()

  if (type.startsWith('route_incident_')) {
    return [
      'route',
      cleanText(payload.source, 30).toUpperCase() || 'UNKNOWN',
      cleanText(payload.method, 16).toUpperCase() || 'UNKNOWN',
      cleanText(payload.path, 500) || '/',
    ].join('|')
  }

  if (type.startsWith('tamper_')) {
    const incidentId = cleanText(payload.incident_id, 100)
    if (incidentId) return `tamper|${incidentId}`

    return [
      'tamper',
      cleanText(payload.target, 80).toLowerCase() || 'unknown',
      cleanText(payload.action, 80).toLowerCase() || 'unknown',
      cleanText(payload.actor, 200).toLowerCase() || 'unknown',
    ].join('|')
  }

  if (type.startsWith('ips_')) {
    const fingerprint = cleanText(payload.fingerprint, 500)
    if (fingerprint) return `ips|${fingerprint}`

    return [
      'ips',
      cleanText(payload.identity_type, 30).toLowerCase() || 'unknown',
      cleanText(payload.source, 30).toUpperCase() || 'UNKNOWN',
      cleanText(payload.method, 16).toUpperCase() || 'UNKNOWN',
      cleanText(payload.path, 500) || '/',
    ].join('|')
  }

  if (type.startsWith('spam_guard_')) {
    return [
      'spam',
      cleanText(payload.scope, 100).toLowerCase() || 'unknown',
      cleanText(payload.identity_type, 30).toLowerCase() || 'unknown',
      cleanText(payload.method, 16).toUpperCase() || 'UNKNOWN',
      cleanText(payload.path, 500) || '/',
    ].join('|')
  }

  if (type.startsWith('kill_switch_')) {
    const id = cleanText(payload.id, 100)
    if (id) return `kill_switch|${id}`

    return [
      'kill_switch',
      cleanText(payload.source, 30).toUpperCase() || 'UNKNOWN',
      cleanText(payload.method, 16).toUpperCase() || 'UNKNOWN',
      cleanText(payload.path, 500) || '/',
    ].join('|')
  }

  return [
    source || 'unknown',
    cleanText(event?.root_event_id, 100)
      || cleanText(event?.event_id, 100)
      || randomUUID(),
  ].join('|')
}

function playbookFor(event) {
  switch (cleanText(event?.type, 80).toLowerCase()) {
    case 'route_incident_active':
    case 'route_incident_reopened':
      return 'distributed_route_containment'
    case 'tamper_attempt_detected':
      return 'tamper_containment'
    case 'ips_defense_escalated':
      return 'identity_containment_followup'
    case 'spam_guard_blocked':
      return 'spam_escalation_followup'
    case 'spam_guard_degraded':
      return 'guard_degraded_recovery'
    case 'kill_switch_expiry_failed':
      return 'containment_recovery'
    default:
      return 'manual_security_review'
  }
}

function cloneResponse(item) {
  return item
    ? {
        ...item,
        payload: safeObject(item.payload),
      }
    : null
}

function evictOldestResponse() {
  let oldestId = ''
  let oldestAt = Infinity

  for (const [id, item] of responses.entries()) {
    if (item.status !== 'resolved') continue

    if (item.updated_at < oldestAt) {
      oldestAt = item.updated_at
      oldestId = id
    }
  }

  if (!oldestId) {
    for (const [id, item] of responses.entries()) {
      if (item.updated_at < oldestAt) {
        oldestAt = item.updated_at
        oldestId = id
      }
    }
  }

  if (!oldestId) return

  const item = responses.get(oldestId)
  responses.delete(oldestId)

  if (item?.key && activeByKey.get(item.key) === oldestId) {
    activeByKey.delete(item.key)
  }
}

function activeCount() {
  let count = 0

  for (const item of responses.values()) {
    if (item.status === 'pending') count += 1
  }

  return count
}

function reportAssistantState(reason, severity = 'info', force = false) {
  const count = activeCount()
  const state = count > 0 ? 'awake' : 'sleeping'

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
    guard: 'security_response_assistant',
    state,
    reason,
    details: {
      active_responses: count,
      stored_responses: responses.size,
    },
    severity,
  })
}

function publishAssistantEvent(type, severity, response, parentEvent = null) {
  const parentHop = Math.max(
    0,
    Math.round(Number(parentEvent?.hop_count) || 0)
  )

  publishSecurityEvent({
    root_event_id:
      cleanText(parentEvent?.root_event_id, 100)
      || cleanText(parentEvent?.event_id, 100)
      || undefined,
    parent_event_id:
      cleanText(parentEvent?.event_id, 100)
      || undefined,
    hop_count: parentEvent ? parentHop + 1 : 0,
    source: 'security_response_assistant',
    target: 'control_plane',
    type,
    severity,
    payload: {
      response_id: response.id,
      response_key: response.key,
      playbook: response.playbook,
      trigger_source: response.trigger_source,
      trigger_type: response.trigger_type,
      trigger_severity: response.trigger_severity,
      status: response.status,
      signal_count: response.signal_count,
    },
  })
}

function createOrCorrelateResponse(event) {
  const key = responseKey(event)
  const existingId = activeByKey.get(key)
  const now = Date.now()

  if (existingId) {
    const existing = responses.get(existingId)

    if (existing && existing.status === 'pending') {
      existing.signal_count += 1
      existing.updated_at = now
      existing.last_event_id = cleanText(event.event_id, 100) || null

      if (event.severity === 'critical') {
        existing.trigger_severity = 'critical'
      }

      return cloneResponse(existing)
    }

    activeByKey.delete(key)
  }

  if (responses.size >= MAX_RESPONSES) {
    evictOldestResponse()
  }

  const response = {
    id: randomUUID(),
    key,
    playbook: playbookFor(event),
    status: 'pending',
    trigger_source: cleanText(event.source, 50).toLowerCase(),
    trigger_type: cleanText(event.type, 80).toLowerCase(),
    trigger_severity: normalizeSeverity(event.severity),
    root_event_id:
      cleanText(event.root_event_id, 100)
      || cleanText(event.event_id, 100)
      || null,
    first_event_id: cleanText(event.event_id, 100) || null,
    last_event_id: cleanText(event.event_id, 100) || null,
    signal_count: 1,
    payload: safeObject(event.payload),
    created_at: now,
    updated_at: now,
    resolved_at: null,
    resolution_reason: null,
  }

  responses.set(response.id, response)
  activeByKey.set(key, response.id)

  publishAssistantEvent(
    'security_response_planned',
    response.trigger_severity,
    response,
    event
  )

  reportAssistantState(
    `Security response planned: ${response.playbook}`,
    response.trigger_severity,
    true
  )

  return cloneResponse(response)
}

function resolveByKey(key, event, reason) {
  const responseId = activeByKey.get(key)
  if (!responseId) return false

  const response = responses.get(responseId)
  if (!response || response.status !== 'pending') {
    activeByKey.delete(key)
    return false
  }

  response.status = 'resolved'
  response.updated_at = Date.now()
  response.resolved_at = response.updated_at
  response.resolution_reason = cleanText(reason, 500)
    || 'Related security signal resolved'

  activeByKey.delete(key)

  publishAssistantEvent(
    'security_response_resolved',
    'info',
    response,
    event
  )

  reportAssistantState(
    activeCount() > 0
      ? 'Security Response Assistant still has pending responses'
      : 'Security Response Assistant sleeping; no pending responses',
    'info',
    true
  )

  return true
}

function handleSecurityEvent(event) {
  if (!event || typeof event !== 'object') return

  const source = cleanText(event.source, 50).toLowerCase()
  const type = cleanText(event.type, 80).toLowerCase()

  if (source === 'security_response_assistant') return
  if (!rememberEventId(event.event_id)) return

  if (resolutionTypes.has(type)) {
    resolveByKey(
      responseKey(event),
      event,
      `Resolved by ${type}`
    )
    return
  }

  if (!triggerTypes.has(type)) return

  const severity = normalizeSeverity(event.severity)
  if (!severity) return

  createOrCorrelateResponse({
    ...event,
    severity,
  })
}

export function startSecurityResponseAssistant() {
  if (unsubscribe) {
    return {
      started: true,
      already_started: true,
    }
  }

  unsubscribe = subscribeSecurityEvents(handleSecurityEvent)

  reportAssistantState(
    'Security Response Assistant sleeping; waiting for confirmed signals',
    'info',
    true
  )

  return {
    started: true,
    already_started: false,
  }
}

export function stopSecurityResponseAssistant() {
  if (unsubscribe) {
    unsubscribe()
    unsubscribe = null
  }

  reportGuardState({
    guard: 'security_response_assistant',
    state: 'offline',
    reason: 'Security Response Assistant stopped',
    details: {
      active_responses: activeCount(),
      stored_responses: responses.size,
    },
    severity: 'info',
  })

  return true
}

export function resolveSecurityResponse({
  responseId,
  reason = 'Security response resolved',
} = {}) {
  const id = cleanText(responseId, 100)
  const response = responses.get(id)

  if (!response || response.status !== 'pending') return false

  response.status = 'resolved'
  response.updated_at = Date.now()
  response.resolved_at = response.updated_at
  response.resolution_reason = cleanText(reason, 500)
    || 'Security response resolved'

  if (activeByKey.get(response.key) === response.id) {
    activeByKey.delete(response.key)
  }

  publishAssistantEvent(
    'security_response_resolved',
    'info',
    response
  )

  reportAssistantState(
    activeCount() > 0
      ? 'Security Response Assistant still has pending responses'
      : 'Security Response Assistant sleeping; no pending responses',
    'info',
    true
  )

  return true
}

export function getSecurityResponseAssistantSnapshot() {
  return {
    started: Boolean(unsubscribe),
    state: activeCount() > 0 ? 'awake' : 'sleeping',
    active_count: activeCount(),
    stored_count: responses.size,
    responses: [...responses.values()]
      .map(cloneResponse)
      .sort((a, b) => b.updated_at - a.updated_at),
  }
}
