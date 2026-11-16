import { supabase } from '../config/supabase.js'

const KNOWN_CODES = new Set([
  'INVALID_CREDENTIALS',
  'READER_SESSION_LIMIT_REACHED',
  'READER_SESSION_REVOKED',
  'READER_SESSION_EXPIRED',
  'READER_SESSION_REQUIRED',
  'READER_SESSION_UNAVAILABLE',
  'READER_LOGIN_CHALLENGE_LIMIT',
  'READER_LOGIN_CHALLENGE_INVALID',
  'READER_LOGIN_CHALLENGE_EXPIRED',
  'READER_LOGIN_DEVICE_MISMATCH',
  'READER_LOGIN_RESTART_REQUIRED',
  'READER_LOGIN_VERIFICATION_UNAVAILABLE',
  'READER_PIN_INVALID',
  'READER_PIN_LOCKED',
  'READER_PIN_INVALID_FORMAT',
  'READER_EMAIL_CODE_INVALID',
  'READER_EMAIL_CODE_EXPIRED',
  'READER_EMAIL_CODE_RATE_LIMIT',
  'READER_EMAIL_CODE_COOLDOWN',
  'TOKEN_REQUIRED',
  'TOKEN_INVALID',
  'TOKEN_EXPIRED',
])
const QUEUE_LIMIT = 240
const BATCH_LIMIT = 40
const FLUSH_DELAY_MS = 20000
const COOLDOWN_MS = 15 * 60 * 1000
const USER_DEDUP_MS = 15 * 60 * 1000
const UNKNOWN_DEDUP_MS = 60 * 1000
const DEDUP_LIMIT = 2500
const REPORT_CACHE_MS = 5 * 60 * 1000
const queue = []
const seen = new Map()
const reportCache = new Map()
let timer = null
let flushing = false
let cooldownUntil = 0
let nextPruneAt = 0
let dropped = 0

function scheduleFlush() {
  if (timer || flushing || queue.length === 0 || Date.now() < cooldownUntil) return
  timer = setTimeout(() => {
    timer = null
    void flushReaderLoginIssues()
  }, FLUSH_DELAY_MS)
  timer.unref?.()
}

export function recordReaderLoginIssue({ userId = '', code = '', source = 'LOGIN' } = {}) {
  try {
    if (process.env.READER_LOGIN_MONITOR_ENABLED === '0') return false
    const errorCode = KNOWN_CODES.has(code) ? code : 'LOGIN_OTHER'
    const issueSource = ['LOGIN', 'VERIFY', 'SESSION'].includes(source) ? source : 'LOGIN'
    const id = /^[0-9a-f-]{36}$/i.test(String(userId || '')) ? String(userId).toLowerCase() : null
    const now = Date.now()
    if (now < cooldownUntil) return false
    const key = `${issueSource}:${errorCode}:${id || 'UNIDENTIFIED'}`
    const last = seen.get(key) || 0
    if (now - last < (id ? USER_DEDUP_MS : UNKNOWN_DEDUP_MS)) return false
    seen.delete(key)
    seen.set(key, now)
    if (seen.size > DEDUP_LIMIT) seen.delete(seen.keys().next().value)
    if (queue.length >= QUEUE_LIMIT) {
      dropped += 1
      return false
    }
    queue.push({ user_id: id, error_code: errorCode, issue_source: issueSource })
    reportCache.clear()
    scheduleFlush()
    return true
  } catch {
    return false
  }
}

export async function flushReaderLoginIssues() {
  if (flushing || !queue.length || Date.now() < cooldownUntil) return
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  flushing = true
  const batch = queue.splice(0, BATCH_LIMIT)
  try {
    const { error } = await supabase.from('reader_login_issue_events').insert(batch)
    if (error) throw error
    reportCache.clear()
    if (Date.now() >= nextPruneAt) {
      nextPruneAt = Date.now() + 24 * 60 * 60 * 1000
      void supabase.rpc('prune_reader_login_issues').then(({ error: pruneError }) => {
        if (pruneError) console.warn('READER_LOGIN_ISSUES_PRUNE:', pruneError.code || 'UNAVAILABLE')
      }).catch(() => {})
    }
  } catch (error) {
    dropped += batch.length + queue.length
    queue.length = 0
    cooldownUntil = Date.now() + COOLDOWN_MS
    console.warn('READER_LOGIN_ISSUES_STORE:', error?.code || 'UNAVAILABLE')
  } finally {
    flushing = false
    scheduleFlush()
  }
}

export async function getReaderLoginIssues(hours = 24) {
  const range = Number(hours) === 168 ? 168 : 24
  const cached = reportCache.get(range)
  if (cached && cached.until > Date.now()) return { ...cached.value, dropped_since_restart: dropped }
  const { data, error } = await supabase.rpc('get_reader_login_issues', { p_hours: range })
  if (error) throw error
  if (!data || typeof data !== 'object' || data.available !== true) throw new Error('LOGIN_MONITOR_REPORT_INVALID')
  reportCache.set(range, { value: data, until: Date.now() + REPORT_CACHE_MS })
  return { ...data, dropped_since_restart: dropped }
}
