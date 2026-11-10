import { createHmac } from 'node:crypto'
import { supabase } from '../config/supabase.js'

const EVENT_TYPES = new Set([
  'session_seen', 'js_error', 'promise_rejection', 'script_load_failure',
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
const QUEUE_LIMIT = 1200
const BATCH_LIMIT = 150
const FLUSH_MS = 60000
const REPORT_CACHE_MS = 90000
const SECRET = process.env.READER_HEALTH_HASH_SECRET || process.env.JWT_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY
const queue = []
let running = false
let nextPruneAt = 0
let lastWarningAt = 0
let nextFlushAt = 0
let lastReport = null
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

function sessionHash(sessionId) {
  return createHmac('sha256', SECRET)
    .update(`shadow-reader-health-v1:${sessionId}`)
    .digest('hex')
    .slice(0, 40)
}

function warnOnce(message) {
  const now = Date.now()
  if (now - lastWarningAt < 5 * 60 * 1000) return
  lastWarningAt = now
  console.warn('READER_HEALTH_TELEMETRY:', String(message).slice(0, 160))
}

async function pruneIfDue() {
  if (Date.now() < nextPruneAt) return
  nextPruneAt = Date.now() + 24 * 60 * 60 * 1000
  try {
    const { error } = await supabase.rpc('prune_reader_health_events')
    if (error) warnOnce(error.code || 'Reader health retention is unavailable')
  } catch {
    warnOnce('Reader health retention failed')
  }
}

export function recordReaderHealthReport(payload) {
  if (!validateReaderHealthPayload(payload)) return false
  const hashed = sessionHash(payload.session_id)
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
      continue
    }
    queue.push(row)
    received += 1
  }
  return true
}

export async function flushReaderHealthTelemetry() {
  if (running || !queue.length || Date.now() < nextFlushAt) return
  running = true
  const batch = queue.splice(0, BATCH_LIMIT)
  try {
    const { error } = await supabase.from('reader_health_events').upsert(batch, {
      onConflict: 'report_id,event_index',
      ignoreDuplicates: true,
    })
    if (error) throw error
    persisted += batch.length
    nextFlushAt = 0
    lastReport = null
    void pruneIfDue()
  } catch (error) {
    const available = QUEUE_LIMIT - queue.length
    const kept = batch.slice(0, Math.max(0, available))
    dropped += batch.length - kept.length
    queue.unshift(...kept)
    nextFlushAt = Date.now() + 5 * 60 * 1000
    warnOnce(error?.code || error?.message || 'Reader health persistence failed')
  } finally {
    running = false
  }
}

export async function getReaderHealthDiagnostics(hours = 24, force = false) {
  const selectedHours = [1, 6, 24, 168].includes(Number(hours)) ? Number(hours) : 24
  if (!force && lastReport?.hours === selectedHours && lastReport.expires > Date.now()) {
    return { ...lastReport.data, ingestion: getReaderHealthIngestionStatus() }
  }
  try {
    const { data, error } = await supabase.rpc('get_reader_health_diagnostics', {
      p_hours: selectedHours,
    })
    if (error) throw error
    if (!data || typeof data !== 'object') throw new Error('Unexpected health report format')
    lastReport = {
      hours: selectedHours,
      expires: Date.now() + REPORT_CACHE_MS,
      data,
    }
    return { ...data, ingestion: getReaderHealthIngestionStatus() }
  } catch (error) {
    warnOnce(error?.code || error?.message || 'Reader health report failed')
    return {
      available: false,
      generated_at: new Date().toISOString(),
      hours: selectedHours,
      status: error?.code === '42883' || error?.code === '42P01'
        ? 'SQL_NOT_INSTALLED' : 'REPORT_UNAVAILABLE',
      ingestion: getReaderHealthIngestionStatus(),
    }
  }
}

export function getReaderHealthIngestionStatus() {
  return {
    queued: queue.length,
    events_received_since_restart: received,
    events_persisted_since_restart: persisted,
    events_dropped_since_restart: dropped,
  }
}

const timer = setInterval(() => { void flushReaderHealthTelemetry() }, FLUSH_MS)
timer.unref?.()
