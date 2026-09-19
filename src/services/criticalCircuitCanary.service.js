import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import jwt from 'jsonwebtoken'
import { getActiveWorkKillSwitchSnapshot } from './workKillSwitch.service.js'
import { isKillSwitchBootstrapVerified } from './workKillSwitchBootstrap.service.js'
import { publishSecurityEvent } from './securityControlPlane.service.js'

const DURATION_MS = 5 * 60 * 1000
const MAX_REQUESTS = 5
const MIN_SUCCESSES = 2
const trials = new Map()

function targetKey(method, path) {
  const m = String(method || '').trim().toUpperCase()
  const p = String(path || '').split('?')[0].trim()
  if (m !== 'GET' || !p.startsWith('/api/') || p.includes(':') || p.includes('*') || p.includes('//') || p.startsWith('/api/admin/work')) return ''
  return `${m}|${p}`
}

function statusOf(trial) {
  if (!trial) return null
  if ((trial.state === 'testing' || trial.state === 'ready') && Date.now() >= trial.expiresAt) {
    trial.state = 'expired'
  }
  return trial.state
}

function view(trial) {
  return {
    method: trial.method,
    path: trial.path,
    state: statusOf(trial),
    started_at: new Date(trial.startedAt).toISOString(),
    expires_at: new Date(trial.expiresAt).toISOString(),
    attempts: trial.attempts,
    successes: trial.successes,
    max_requests: MAX_REQUESTS,
    min_successes: MIN_SUCCESSES,
    in_flight: trial.inFlight,
  }
}

function activeAutomaticRecord(method, path) {
  if (!isKillSwitchBootstrapVerified() || !targetKey(method, path)) return null
  return getActiveWorkKillSwitchSnapshot().find((record) =>
    record.target_type === 'api' && record.source === 'ALL' &&
    record.method === 'GET' && record.path === path &&
    record.mode === 'automatic' && !record.expires_at
  ) || null
}

function matchesToken(token, digest) {
  if (typeof token !== 'string' || token.length !== 64 || !/^[a-f0-9]{64}$/i.test(token)) return false
  const supplied = createHash('sha256').update(token).digest()
  return timingSafeEqual(supplied, digest)
}

export function startCriticalCanary({ method, path, owner } = {}) {
  const key = targetKey(method, path)
  const sessionId = String(owner?.session_id || '').trim()
  if (!key) throw new Error('Half-open supports exact GET API paths only')
  if (String(owner?.role || '').toLowerCase() !== 'owner' || !sessionId) throw new Error('Verified Owner session required')
  const record = activeAutomaticRecord('GET', path)
  if (!record) throw new Error('Critical route must be persistently latched before testing')
  const existing = trials.get(key)
  if (existing?.inFlight) throw new Error('A canary request is still running')
  const token = randomBytes(32).toString('hex')
  const trial = {
    key, method: 'GET', path, recordId: record.id,
    ownerSessionId: sessionId,
    tokenDigest: createHash('sha256').update(token).digest(),
    startedAt: Date.now(), expiresAt: Date.now() + DURATION_MS,
    state: 'testing', attempts: 0, successes: 0, inFlight: false,
  }
  trials.set(key, trial)
  publishSecurityEvent({source:'kill_switch',target:'control_plane',type:'critical_canary_started',severity:'medium',payload:{method:'GET',path}})
  return { ...view(trial), canary_token: token }
}

export function getCriticalCanaryStatus({ method, path } = {}) {
  const key = targetKey(method, path)
  if (!key) return null
  const trial = trials.get(key)
  return trial ? view(trial) : null
}

export function tryCriticalCanaryRequest({ req, res, record, path } = {}) {
  const key = targetKey(req?.method, path)
  const trial = key ? trials.get(key) : null
  if (!trial || statusOf(trial) !== 'testing' || !record || record.id !== trial.recordId || trial.attempts >= MAX_REQUESTS || trial.inFlight) return false
  const token = req.headers['x-shadow-circuit-canary']
  if (!matchesToken(token, trial.tokenDigest)) return false
  const header = String(req.headers.authorization || '')
  if (!header.startsWith('Bearer ') || !process.env.JWT_SECRET) return false
  let decoded
  try { decoded = jwt.verify(header.slice(7), process.env.JWT_SECRET) } catch { return false }
  if (String(decoded?.role || '').toLowerCase() !== 'owner' || String(decoded?.session_id || '') !== trial.ownerSessionId) return false
  trial.attempts += 1
  trial.inFlight = true
  res.setHeader('X-Shadow-Work-Switch', 'half-open')
  let completed = false
  const finish = (ok) => {
    if (completed) return
    completed = true
    trial.inFlight = false
    if (trials.get(key) !== trial) return
    if (!ok) {
      trial.state = 'failed'
      publishSecurityEvent({source:'kill_switch',target:'control_plane',type:'critical_canary_failed',severity:'high',payload:{method:'GET',path,status:res.statusCode}})
      return
    }
    trial.successes += 1
    if (trial.successes >= MIN_SUCCESSES) trial.state = 'ready'
    else if (trial.attempts >= MAX_REQUESTS) trial.state = 'failed'
  }
  res.once('finish', () => finish(res.statusCode >= 200 && res.statusCode < 300))
  res.once('close', () => finish(false))
  return true
}

export function criticalCanaryReadyForRelease({ method, path } = {}) {
  const key = targetKey(method, path)
  const trial = key ? trials.get(key) : null
  if (!trial || statusOf(trial) !== 'ready' || trial.inFlight || trial.successes < MIN_SUCCESSES) return false
  const record = activeAutomaticRecord(method, path)
  return Boolean(record && record.id === trial.recordId)
}

export function clearCriticalCanary({ method, path } = {}) {
  const key = targetKey(method, path)
  if (key) trials.delete(key)
}
