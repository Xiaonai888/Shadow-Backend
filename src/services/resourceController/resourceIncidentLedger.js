import { getResourcePolicy } from './resourcePolicies.js'

const MAX_CONDITIONS = 120
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000
const conditions = new Map()

function safe(value, max = 180) {
  return String(value ?? '')
    .replace(/Bearer\s+\S+/gi, '[REDACTED]')
    .replace(/https?:\/\/\S+/gi, '[URL REDACTED]')
    .replace(/(token|secret|password|authorization)\s*[=:]\s*\S+/gi, '$1=[REDACTED]')
    .slice(0, max)
}

function normalizeTimestamp(at) {
  const result = Number(at)
  return Number.isFinite(result) && result >= 0 ? result : Date.now()
}

function conditionKey(jobType, jobId, code) {
  return `${jobType}:${jobId}:${code}`
}

function prune(now) {
  for (const [key, value] of conditions) {
    if (now - value.lastSeenMs > RETENTION_MS) conditions.delete(key)
  }
  while (conditions.size > MAX_CONDITIONS) {
    conditions.delete(conditions.keys().next().value)
  }
}

export function observeResourceCondition({
  jobType,
  jobId,
  code,
  reason = '',
  stage = 'worker_queue',
  confirmedFailure = false,
  at = Date.now(),
} = {}) {
  const type = String(jobType || '').trim()
  const id = String(jobId || '').trim()
  const codeText = safe(code, 80)
  if (!id || !codeText || !getResourcePolicy(type).schedulable) return null

  const now = normalizeTimestamp(at)
  prune(now)
  const key = conditionKey(type, id, codeText)
  const previous = conditions.get(key)
  const record = {
    jobType: type,
    jobTag: safe(id.slice(-12), 12),
    code: codeText,
    stage: safe(stage, 40),
    reason: safe(reason),
    state: 'OPEN',
    confirmedFailure: confirmedFailure === true,
    firstSeenMs: previous?.firstSeenMs ?? now,
    lastSeenMs: now,
    occurrences: (previous?.occurrences || 0) + 1,
    resolvedAtMs: null,
  }
  conditions.delete(key)
  conditions.set(key, record)
  prune(now)
  return { ...record }
}

export function resolveResourceCondition({ jobType, jobId, code, at = Date.now() } = {}) {
  const type = String(jobType || '').trim()
  const id = String(jobId || '').trim()
  const key = conditionKey(type, id, safe(code, 80))
  const previous = conditions.get(key)
  if (!previous || previous.state === 'RESOLVED') return false
  const now = normalizeTimestamp(at)
  conditions.delete(key)
  conditions.set(key, { ...previous, state: 'RESOLVED', lastSeenMs: now, resolvedAtMs: now })
  return true
}

export function getResourceConditionsSnapshot({ limit = 20 } = {}) {
  prune(Date.now())
  const count = Math.max(0, Math.min(MAX_CONDITIONS, Math.floor(Number(limit) || 0)))
  const all = [...conditions.values()]
  const openCount = all.filter((item) => item.state === 'OPEN').length
  return {
    source: 'observed_resource_conditions',
    storage: 'in_process_memory_only',
    retentionTargetDays: 7,
    persistedAcrossRestart: false,
    conditionCount: all.length,
    openCount,
    conditions: count ? all.slice(-count).reverse().map((item) => ({ ...item })) : [],
  }
}
