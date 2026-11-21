import { getResourcePolicy } from './resourcePolicies.js'

const MAX_EVENTS = 320
const MAX_JOBS = 128
const MAX_TEXT = 180
const EVENT_DEDUP_MS = 30000
const JOB_TTL_MS = 12 * 60 * 60 * 1000

const events = []
const latestByJob = new Map()
let sequence = 0

function safe(value, max = MAX_TEXT) {
  return String(value ?? '')
    .replace(/Bearer\s+\S+/gi, '[REDACTED]')
    .replace(/https?:\/\/\S+/gi, '[URL REDACTED]')
    .replace(/(token|secret|password|authorization)\s*[=:]\s*\S+/gi, '$1=[REDACTED]')
    .slice(0, max)
}

function numeric(value) {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : null
}

function timestamp(value) {
  const result = Number(value)
  return Number.isFinite(result) && result >= 0 ? result : Date.now()
}

function compactOld(now) {
  for (const [key, item] of latestByJob) {
    if (now - item.at > JOB_TTL_MS) latestByJob.delete(key)
  }
  while (latestByJob.size > MAX_JOBS) {
    latestByJob.delete(latestByJob.keys().next().value)
  }
}

export function recordResourceJobEvidence({
  jobType,
  jobId,
  stage,
  state,
  code = '',
  reason = '',
  queueAgeSeconds = null,
  attempts = null,
  at = Date.now(),
} = {}) {
  const type = String(jobType || '').trim()
  const id = String(jobId || '').trim()
  if (!id || !getResourcePolicy(type).schedulable) return null

  const now = timestamp(at)
  compactOld(now)
  const key = `${type}:${id}`
  const entry = {
    at: now,
    jobType: type,
    jobTag: safe(id.slice(-12), 12),
    stage: safe(stage || 'unknown', 45),
    state: safe(state || 'unknown', 45),
    code: safe(code, 80),
    reason: safe(reason, MAX_TEXT),
    queueAgeSeconds: numeric(queueAgeSeconds),
    attempts: numeric(attempts),
  }
  const previous = latestByJob.get(key)
  const unchanged = previous &&
    previous.stage === entry.stage &&
    previous.state === entry.state &&
    previous.code === entry.code &&
    previous.reason === entry.reason
  latestByJob.delete(key)
  latestByJob.set(key, entry)
  if (unchanged && now - previous.at < EVENT_DEDUP_MS) return null

  sequence += 1
  const event = { sequence, ...entry }
  events.push(event)
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS)
  return { ...event }
}

export function getResourceJobEvidenceSnapshot({ limit = 30 } = {}) {
  compactOld(Date.now())
  const count = Math.max(0, Math.min(MAX_EVENTS, Math.floor(Number(limit) || 0)))
  return {
    source: 'instrumented_job_events_only',
    captureEnabled: true,
    persistent: false,
    recordedEventCount: sequence,
    trackedJobCount: latestByJob.size,
    events: count ? events.slice(-count).map((item) => ({ ...item })) : [],
  }
}
