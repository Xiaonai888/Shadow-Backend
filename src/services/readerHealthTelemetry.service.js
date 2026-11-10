import { createHmac } from 'node:crypto'
import { supabase } from '../config/supabase.js'

const EVENT_TYPES = new Set([
  'js_error', 'promise_rejection', 'script_load_failure',
  'long_task', 'event_loop_delay', 'slow_api', 'slow_boot',
])
const PAGE_GROUPS = new Set([
  'HOME', 'DISCOVER', 'READ', 'STORY', 'MANGA', 'FAST',
  'STORE', 'MINE', 'AUTHOR', 'CHAT', 'OTHER',
])
const BROWSERS = new Set(['EDGE', 'SAMSUNG', 'CHROME', 'FIREFOX', 'SAFARI', 'OTHER'])
const SYSTEMS = new Set(['ANDROID', 'IOS', 'WINDOWS', 'MACOS', 'LINUX', 'OTHER'])
const DEVICES = new Set(['MOBILE', 'TABLET', 'DESKTOP'])
const CRITICAL = new Set(['js_error', 'promise_rejection', 'script_load_failure'])
const QUEUE_LIMIT = 600
const BATCH_LIMIT = 120
const FLUSH_DELAY_MS = 30000
const FAILURE_COOLDOWN_MS = 15 * 60 * 1000
const REPORT_CACHE_MS = 5 * 60 * 1000
const FAILURE_CACHE_MS = 10 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
const MAX_SESSIONS = 5000
const MAX_REPORTS_PER_SESSION = 3
const SECRET = process.env.READER_HEALTH_HASH_SECRET || process.env.JWT_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY
const queue = []
const sessions = new Map()
const reports = new Map()
const inFlightReports = new Map()
let flushTimer = null
let running = false
let nextPruneAt = 0
let cooldownUntil = 0
let lastWarningAt = 0
let received = 0
let dropped = 0
let persisted = 0

function validUuid(value) {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

function validEvent(event, sampled) {
  return event && typeof event === 'object' &&
    EVENT_TYPES.has(event.type) &&
    (sampled || CRITICAL.has(event.type)) &&
    PAGE_GROUPS.has(event.page) &&
    typeof event.code === 'string' &&
    (event.code === '' || /^E-[0-9A-F]{8}$/.test(event.code)) &&
    Number.isSafeInteger(event.metric_ms) &&
    event.metric_ms >= 0 && event.metric_ms <= 60000
}

export function validateReaderHealthPayload(payload) {
  return payload && typeof payload === 'object' &&
    payload.version === 1 &&
    validUuid(payload.report_id) &&
    typeof payload.session_id === 'string' &&
    /^[0-9a-f-]{16,64}$/i.test(payload.session_id) &&
    typeof payload.sampled === 'boolean' &&
    BROWSERS.has(payload.browser) &&
    SYSTEMS.has(payload.os) &&
    DEVICES.has(payload.device) &&
    Array.isArray(payload.events) &&
    payload.events.length >= 1 && payload.events.length <= 6 &&
    payload.events.every((event) => validEvent(event, payload.sampled))
}

function sessionHash(value) {
  return createHmac('sha256', SECRET)
    .update(`shadow-reader-health-v1:${value}`)
    .digest('hex')
    .slice(0, 40)
}

function warnOnce(message) {
  const now = Date.now()
  if (now - lastWarningAt < 5 * 60 * 1000) return
  lastWarningAt = now
  console.warn('READER_HEALTH_TELEMETRY:', String(message).slice(0, 160))
}

function scheduleFlush() {
  if (flushTimer || running || !queue.length || Date.now() < cooldownUntil) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    void flushReaderHealthTelemetry()
  }, FLUSH_DELAY_MS)
  flushTimer.unref?.()
}

async function pruneIfDue() {
  if (Date.now() < nextPruneAt) return
  nextPruneAt = Date.now() + DAY_MS
  try {
    const { error } = await supabase.rpc('prune_reader_health_events')
    if (error) warnOnce(error.code || 'Reader health retention is unavailable')
  } catch {
    warnOnce('Reader health retention failed')
  }
}

export function recordReaderHealthReport(payload) {
  if (!validateReaderHealthPayload(payload)) return false
  if (Date.now() < cooldownUntil) {
    dropped += payload.events.length
    return true
  }
  const hashed = sessionHash(payload.session_id)
  const day = new Date().toISOString().slice(0, 10)
  const key = `${day}:${hashed}`
  const prior = sessions.get(key) || 0
  if (prior >= MAX_REPORTS_PER_SESSION) {
    dropped += payload.events.length
    return true
  }
  sessions.delete(key)
  sessions.set(key, prior + 1)
  if (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value)
  const rows = payload.events.map((event, index) => ({
    report_id: payload.report_id,
    event_index: index,
    session_hash: hashed,
    sampled: payload.sampled,
    event_type: event.type,
    page_group: event.page,
    fingerprint: event.code,
    metric_ms: event.metric_ms,
    browser: payload.browser,
    os: payload.os,
    device: payload.device,
  }))
  for (const row of rows) {
    if (queue.length >= QUEUE_LIMIT) {
      dropped += 1
    } else {
      queue.push(row)
      received += 1
    }
  }
  scheduleFlush()
  return true
}

export async function flushReaderHealthTelemetry() {
  if (running || !queue.length || Date.now() < cooldownUntil) return
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  running = true
  const batch = queue.splice(0, BATCH_LIMIT)
  try {
    const { error } = await supabase.from('reader_health_events').upsert(batch, {
      onConflict: 'report_id,event_index',
      ignoreDuplicates: true,
    })
    if (error) throw error
    persisted += batch.length
    reports.clear()
    void pruneIfDue()
  } catch (error) {
    cooldownUntil = Date.now() + FAILURE_COOLDOWN_MS
    dropped += batch.length + queue.length
    queue.length = 0
    warnOnce(error?.code || error?.message || 'Reader health persistence failed')
  } finally {
    running = false
    scheduleFlush()
  }
}

export function getReaderHealthIngestionStatus() {
  return {
    queued: queue.length,
    events_received_since_restart: received,
    events_persisted_since_restart: persisted,
    events_dropped_since_restart: dropped,
    write_paused_until: cooldownUntil > Date.now() ? new Date(cooldownUntil).toISOString() : null,
  }
}

export async function getReaderHealthDiagnostics(hours = 24) {
  const selectedHours = [1, 6, 24, 168].includes(Number(hours)) ? Number(hours) : 24
  const cached = reports.get(selectedHours)
  if (cached && cached.expires > Date.now()) {
    return { ...cached.data, ingestion: getReaderHealthIngestionStatus() }
  }
  if (inFlightReports.has(selectedHours)) {
    const data = await inFlightReports.get(selectedHours)
    return { ...data, ingestion: getReaderHealthIngestionStatus() }
  }
  const request = (async () => {
    try {
      const { data, error } = await supabase.rpc('get_reader_health_diagnostics', {
        p_hours: selectedHours,
      })
      if (error) throw error
      if (!data || typeof data !== 'object') throw new Error('Unexpected health report format')
      reports.set(selectedHours, { data, expires: Date.now() + REPORT_CACHE_MS })
      return data
    } catch (error) {
      warnOnce(error?.code || error?.message || 'Reader health report failed')
      const data = {
        available: false,
        generated_at: new Date().toISOString(),
        hours: selectedHours,
        status: ['42883', '42P01'].includes(error?.code) ? 'SQL_NOT_INSTALLED' : 'REPORT_UNAVAILABLE',
      }
      reports.set(selectedHours, { data, expires: Date.now() + FAILURE_CACHE_MS })
      return data
    }
  })()
  inFlightReports.set(selectedHours, request)
  try {
    const data = await request
    return { ...data, ingestion: getReaderHealthIngestionStatus() }
  } finally {
    inFlightReports.delete(selectedHours)
  }
}
