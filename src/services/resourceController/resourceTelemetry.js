import { getResourcePolicy } from './resourcePolicies.js'

const MAX_ACTIVE = 96
const MAX_EVENTS = 240
const MAX_DECISIONS = 160
const DECISION_REPEAT_MS = 60000
const active = new Map()
const events = []
const decisions = new Map()
let sequence = 0

function safeText(value, limit = 96) {
  return String(value ?? '').replace(/[^a-zA-Z0-9_:\-. ]/g, '_').slice(0, limit)
}

function timeValue(value) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : Date.now()
}

function jobKey(jobType, jobId) {
  return `${String(jobType)}:${String(jobId)}`
}

function jobTag(value) {
  return safeText(String(value || '').slice(-12), 12)
}

function pushEvent(entry) {
  sequence += 1
  events.push({ sequence, ...entry })
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS)
}

export function recordResourceJobEvent({
  jobType,
  jobId,
  event,
  reason = '',
  at = Date.now(),
} = {}) {
  const policy = getResourcePolicy(jobType)
  const id = String(jobId || '').trim()
  const state = safeText(event, 32)
  if (!id || !state) return false

  const key = jobKey(policy.jobType, id)
  const timestamp = timeValue(at)
  const previous = active.get(key)
  const terminal = ['completed', 'failed', 'canceled', 'stopped'].includes(state)

  if (state === 'started' && !previous && active.size >= MAX_ACTIVE) {
    pushEvent({
      at: timestamp,
      jobType: policy.jobType,
      jobTag: jobTag(id),
      event: 'tracking_capacity_reached',
      reason: 'ACTIVE_TRACKING_LIMIT',
    })
    return false
  }

  if (state === 'started') {
    active.set(key, {
      jobType: policy.jobType,
      jobTag: jobTag(id),
      lane: policy.lane,
      state: 'running',
      startedAt: timestamp,
    })
  } else if (terminal) {
    active.delete(key)
  }

  pushEvent({
    at: timestamp,
    jobType: policy.jobType,
    jobTag: jobTag(id),
    event: state,
    reason: safeText(reason, 96),
    durationMs: terminal && previous ? Math.max(0, timestamp - previous.startedAt) : null,
  })
  return true
}

export function recordResourceAdmissionDecision({
  jobType,
  jobId,
  allowed,
  reason,
  at = Date.now(),
} = {}) {
  const policy = getResourcePolicy(jobType)
  const key = jobKey(policy.jobType, String(jobId || 'unnamed'))
  const timestamp = timeValue(at)
  const normalizedReason = safeText(reason, 90)
  const previous = decisions.get(key)
  if (
    previous && previous.reason === normalizedReason &&
    previous.allowed === Boolean(allowed) &&
    timestamp - previous.at < DECISION_REPEAT_MS
  ) return false

  if (decisions.size >= MAX_DECISIONS && !decisions.has(key)) {
    const oldest = decisions.keys().next().value
    decisions.delete(oldest)
  }
  decisions.delete(key)
  decisions.set(key, { at: timestamp, allowed: Boolean(allowed), reason: normalizedReason })
  pushEvent({
    at: timestamp,
    jobType: policy.jobType,
    jobTag: jobTag(jobId),
    event: allowed ? 'admitted' : 'deferred',
    reason: normalizedReason,
  })
  return true
}

export function getResourceTelemetrySnapshot({ eventLimit = 40 } = {}) {
  const count = Math.max(0, Math.min(MAX_EVENTS, Math.floor(Number(eventLimit) || 0)))
  const running = [...active.values()].map((entry) => ({ ...entry }))
  return {
    running,
    runningCount: running.length,
    events: count ? events.slice(-count).map((event) => ({ ...event })) : [],
    trackedEventCount: events.length,
    totalEventSequence: sequence,
    trackingCapacity: MAX_ACTIVE,
    eventCapacity: MAX_EVENTS,
    persistent: false,
  }
}

export function getResourceTelemetrySummary() {
  return {
    state: active.size ? 'working' : 'idle',
    active_jobs: active.size,
    recent_events: events.length,
    persistent: false,
  }
}
