import { supabase } from '../config/supabase.js'
import { buildDatabaseIoInterval, buildDatabaseIoReport } from './databaseIoEvidence.service.js'

const PERIOD_MS = 15 * 60 * 1000
const TIMEOUT_MS = 12000
const MAX_INTERVALS = 96
let timer = null, running = false, active = false, generation = 0, failures = 0
let baseline = null, history = [], lastSuccess = null, lastAttempt = null, lastError = null

function validate(data) {
  if (!data || data.version !== 1 || !Number.isFinite(Date.parse(data.captured_at)) || !Number.isFinite(Date.parse(data.server_started_at)) || !Number.isInteger(data.block_bytes) || data.block_bytes <= 0 || !Array.isArray(data.queries) || data.queries.length > 5000 || !Array.isArray(data.activity)) throw new Error('Invalid IO snapshot')
  if (data.queries.some(r => !Array.isArray(r) || r.length !== 12 || typeof r[0] !== 'string' || !Array.isArray(r[1]))) throw new Error('Invalid IO query rows')
  return data
}

function schedule(delay, id) {
  if (!active || generation !== id) return
  timer = setTimeout(() => { timer = null; void sample(id) }, delay)
  timer.unref?.()
}

async function sample(id) {
  if (!active || id !== generation) return
  if (running) { schedule(PERIOD_MS, id); return }
  running = true
  lastAttempt = new Date().toISOString()
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const { data, error } = await supabase.rpc('shadow_database_io_snapshot_v1').abortSignal(controller.signal)
    if (error) throw error
    const snapshot = validate(data)
    if (!active || id !== generation) return
    if (baseline) {
      const interval = buildDatabaseIoInterval(baseline, snapshot)
      history.push(interval)
      if (history.length > MAX_INTERVALS) history.shift()
    }
    baseline = snapshot
    failures = 0
    lastSuccess = snapshot.captured_at
    lastError = null
  } catch (error) {
    if (!active || id !== generation) return
    failures++
    lastError = { at: new Date().toISOString(), kind: controller.signal.aborted ? 'timeout' : 'snapshot_failed', code: /^[A-Z0-9_]{1,40}$/i.test(String(error?.code || '')) ? String(error.code) : null }
  } finally {
    clearTimeout(timeout)
    running = false
    if (active && id === generation) schedule(Math.min(PERIOD_MS * 2 ** Math.min(failures, 2), 60 * 60 * 1000), id)
  }
}

export function startDatabaseIoMonitor() {
  if (active) return
  active = true
  const id = ++generation
  schedule(60000, id)
}

export function stopDatabaseIoMonitor() {
  active = false
  generation++
  clearTimeout(timer)
  timer = null
  baseline = null
}

export function getDatabaseIoReport() {
  return buildDatabaseIoReport(history, { enabled: active, sampling: running, last_attempt: lastAttempt, last_success: lastSuccess, last_error: lastError, consecutive_failures: failures, interval_minutes: 15, storage: 'process_memory_only', retention_intervals: MAX_INTERVALS })
}
