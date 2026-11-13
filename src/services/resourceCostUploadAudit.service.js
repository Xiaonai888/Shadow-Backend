import { randomUUID } from 'node:crypto'
import {
  resourceCostKey,
  resourceCostNonnegativeInteger,
  resourceCostUtcHour,
} from './resourceCostMath.service.js'

const MAX_GROUPS = 512
const MODES = new Set(['direct', 'proxy', 'background'])
const STATUSES = new Set(['success', 'failure'])
const startedAt = new Date().toISOString()

let pending = new Map()
let retryBatch = null
let inFlight = false
let lastSuccessAt = null
let lastFailureAt = null
let failedFlushes = 0
let overflowEvents = 0
let totalObservedEvents = 0

function normalizedUpload(input) {
  if (!input || typeof input !== 'object') throw new TypeError('Upload audit input is required.')
  if (!MODES.has(input.mode)) throw new TypeError('Invalid upload mode.')
  if (!STATUSES.has(input.status)) throw new TypeError('Invalid upload status.')
  return {
    hour_start: resourceCostUtcHour(input.occurredAt || new Date()),
    feature: resourceCostKey(input.feature, 'feature', 64),
    route: resourceCostKey(input.route, 'route', 96),
    upload_mode: input.mode,
    attempts: 1,
    successes: input.status === 'success' ? 1 : 0,
    failures: input.status === 'failure' ? 1 : 0,
    ingress_bytes: resourceCostNonnegativeInteger(input.ingressBytes ?? 0, 'ingressBytes'),
    egress_bytes: resourceCostNonnegativeInteger(input.egressBytes ?? 0, 'egressBytes'),
    object_bytes: resourceCostNonnegativeInteger(input.objectBytes ?? 0, 'objectBytes'),
  }
}

function groupKey(row) {
  return [row.hour_start, row.feature, row.route, row.upload_mode].join('\u001f')
}

function combine(map, row) {
  const key = groupKey(row)
  const previous = map.get(key)
  if (!previous) {
    map.set(key, { ...row })
    return
  }
  for (const field of ['attempts', 'successes', 'failures', 'ingress_bytes', 'egress_bytes', 'object_bytes']) {
    const value = previous[field] + row[field]
    if (!Number.isSafeInteger(value)) throw new RangeError('Upload audit counter exceeded the safe integer limit.')
    previous[field] = value
  }
}

export function recordResourceCostUpload(input) {
  const original = normalizedUpload(input)
  let row = original
  if (!pending.has(groupKey(row)) && pending.size >= MAX_GROUPS) {
    row = { ...row, feature: 'other', route: 'overflow' }
    overflowEvents += 1
  }
  combine(pending, row)
  totalObservedEvents += 1
  return true
}

async function commitBatch(batch) {
  const { supabase } = await import('../config/supabase.js')
  const { data, error } = await supabase.rpc('resource_cost_commit_upload_batch', {
    p_batch_id: batch.id,
    p_rows: batch.rows,
  })
  if (error) throw error
  return data
}

export async function flushResourceCostUploadAudit(persist = commitBatch) {
  if (typeof persist !== 'function') throw new TypeError('Persist callback must be a function.')
  if (inFlight) return { status: 'busy' }
  if (!retryBatch && pending.size === 0) return { status: 'empty' }
  inFlight = true
  try {
    if (!retryBatch) {
      const rows = [...pending.values()].slice(0, 250)
      for (const row of rows) pending.delete(groupKey(row))
      retryBatch = { id: randomUUID(), rows }
    }
    const batch = retryBatch
    const result = await persist(batch)
    retryBatch = null
    lastSuccessAt = new Date().toISOString()
    return { status: 'ok', batch_id: batch.id, rows: batch.rows.length, result }
  } catch (error) {
    failedFlushes += 1
    lastFailureAt = new Date().toISOString()
    throw error
  } finally {
    inFlight = false
  }
}

export function getResourceCostUploadAuditHealth() {
  const pendingRecords = [...pending.values()]
  const retryRecords = retryBatch?.rows || []
  const records = [...pendingRecords, ...retryRecords]
  return {
    runtime_started_at: startedAt,
    last_flush_at: lastSuccessAt,
    last_error_at: lastFailureAt,
    failed_flushes: failedFlushes,
    in_flight: inFlight,
    pending_batches: retryBatch ? 1 : 0,
    pending_groups: records.length,
    pending_attempts: records.reduce((sum, row) => sum + row.attempts, 0),
    pending_ingress_bytes: records.reduce((sum, row) => sum + row.ingress_bytes, 0),
    pending_egress_bytes: records.reduce((sum, row) => sum + row.egress_bytes, 0),
    overflow_events: overflowEvents,
    observed_events_since_start: totalObservedEvents,
    durability: 'memory_until_successful_batch_commit',
  }
}
