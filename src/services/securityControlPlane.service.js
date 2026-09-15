import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'

const MAX_EVENTS = 500
const MAX_SEEN_EVENTS = 1000
const MAX_EVENT_HOPS = 6

const emitter = new EventEmitter()
emitter.setMaxListeners(100)

const allowedGuards = new Set([
  'worker',
  'ips',
  'spam_guard',
  'kill_switch',
  'security_gate',
  'tamper_guard',
  'security_response_assistant',
  'control_plane',
])

const allowedStates = new Set([
  'sleeping',
  'monitoring',
  'awake',
  'defending',
  'restricted',
  'blocked',
  'isolated',
  'degraded',
  'critical',
  'safe_mode',
  'offline',
])

const allowedSeverities = new Set([
  'info',
  'low',
  'medium',
  'high',
  'critical',
])

const guardStates = new Map()
const events = []
const seenEventIds = new Set()
const seenEventQueue = []

let controlState = {
  mode: 'normal',
  reason: null,
  changed_at: Date.now(),
}

function cleanText(value, maxLength = 500) {
  return String(value || '').trim().slice(0, maxLength)
}

function normalizeGuard(value) {
  const guard = cleanText(value, 50).toLowerCase()
  return allowedGuards.has(guard) ? guard : 'control_plane'
}

function normalizeState(value) {
  const state = cleanText(value, 40).toLowerCase()
  return allowedStates.has(state) ? state : 'monitoring'
}

function normalizeSeverity(value) {
  const severity = cleanText(value, 20).toLowerCase()
  return allowedSeverities.has(severity) ? severity : 'info'
}

function safePayload(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return { ...value }
}

function rememberEventId(eventId) {
  if (seenEventIds.has(eventId)) return false

  seenEventIds.add(eventId)
  seenEventQueue.push(eventId)

  while (seenEventQueue.length > MAX_SEEN_EVENTS) {
    const oldest = seenEventQueue.shift()
    if (oldest) seenEventIds.delete(oldest)
  }

  return true
}

function storeEvent(event) {
  events.push(event)

  while (events.length > MAX_EVENTS) {
    events.shift()
  }
}

export function publishSecurityEvent(input = {}) {
  const eventId = cleanText(input.event_id, 100) || randomUUID()
  const hopCount = Math.max(0, Math.round(Number(input.hop_count) || 0))

  if (hopCount > MAX_EVENT_HOPS) return null
  if (!rememberEventId(eventId)) return null

  const now = Date.now()
  const event = {
    event_id: eventId,
    root_event_id: cleanText(input.root_event_id, 100) || eventId,
    parent_event_id: cleanText(input.parent_event_id, 100) || null,
    hop_count: hopCount,
    source: normalizeGuard(input.source),
    target: cleanText(input.target, 50).toLowerCase() || 'all',
    type: cleanText(input.type, 80).toLowerCase() || 'security_event',
    severity: normalizeSeverity(input.severity),
    payload: safePayload(input.payload),
    created_at: now,
  }

  storeEvent(event)
  emitter.emit('security_event', { ...event, payload: { ...event.payload } })

  return { ...event, payload: { ...event.payload } }
}

export function reportGuardState({
  guard,
  state,
  reason = '',
  details = {},
  severity = 'info',
} = {}) {
  const name = normalizeGuard(guard)
  const now = Date.now()

  const record = {
    guard: name,
    state: normalizeState(state),
    reason: cleanText(reason, 500) || null,
    details: safePayload(details),
    updated_at: now,
  }

  guardStates.set(name, record)

  publishSecurityEvent({
    source: name,
    target: 'control_plane',
    type: 'guard_state_changed',
    severity,
    payload: {
      state: record.state,
      reason: record.reason,
    },
  })

  return {
    ...record,
    details: { ...record.details },
  }
}

export function enterSecuritySafeMode({
  source = 'control_plane',
  reason = 'Security control degraded',
  severity = 'critical',
} = {}) {
  const now = Date.now()

  controlState = {
    mode: 'safe_mode',
    reason: cleanText(reason, 500) || 'Security control degraded',
    changed_at: now,
  }

  publishSecurityEvent({
    source,
    target: 'all',
    type: 'safe_mode_entered',
    severity,
    payload: {
      reason: controlState.reason,
    },
  })

  return { ...controlState }
}

export function restoreSecurityNormalMode({
  source = 'control_plane',
  reason = 'Security control restored',
} = {}) {
  const now = Date.now()

  controlState = {
    mode: 'normal',
    reason: cleanText(reason, 500) || null,
    changed_at: now,
  }

  publishSecurityEvent({
    source,
    target: 'all',
    type: 'normal_mode_restored',
    severity: 'info',
    payload: {
      reason: controlState.reason,
    },
  })

  return { ...controlState }
}

export function subscribeSecurityEvents(listener) {
  if (typeof listener !== 'function') {
    throw new TypeError('Security event listener must be a function')
  }

  emitter.on('security_event', listener)

  return () => {
    emitter.off('security_event', listener)
  }
}

export function getSecurityControlSnapshot() {
  return {
    control: { ...controlState },
    guards: [...guardStates.values()]
      .map((item) => ({
        ...item,
        details: { ...item.details },
      }))
      .sort((a, b) => a.guard.localeCompare(b.guard)),
    recent_events: events
      .slice()
      .reverse()
      .map((event) => ({
        ...event,
        payload: { ...event.payload },
      })),
  }
}

export function getGuardState(guard) {
  const record = guardStates.get(normalizeGuard(guard))

  return record
    ? {
        ...record,
        details: { ...record.details },
      }
    : null
}

export function isSecuritySafeMode() {
  return controlState.mode === 'safe_mode'
}
