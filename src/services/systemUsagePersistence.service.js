import { supabase } from '../config/supabase.js'
import { getSystemUsageSnapshot } from './systemUsageMonitor.service.js'

const SNAPSHOT_MS = 15 * 60 * 1000
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000
const CLEANUP_MS = 24 * 60 * 60 * 1000
const MAX_DETAIL_ROWS = 100

let startTimer = null
let intervalTimer = null
let writing = false
let lastCleanupAt = 0

function alignedWindowEnd(now = Date.now()) {
  return Math.floor(now / SNAPSHOT_MS) * SNAPSHOT_MS
}

function aggregateRows(minutes) {
  const rows = new Map()

  for (const minute of minutes) {
    for (const row of minute.rows || []) {
      const key = [
        row.kind || 'unknown',
        row.feature || 'unknown',
        row.source_route || 'UNKNOWN',
        row.dependency || 'UNKNOWN',
      ].join('\u001f')

      const current = rows.get(key) || {
        kind: row.kind || 'unknown',
        feature: row.feature || 'unknown',
        source_route: row.source_route || 'UNKNOWN',
        dependency: row.dependency || 'UNKNOWN',
        count: 0,
        bytes: 0,
        errors: 0,
        weighted_ms: 0,
      }

      const count = Math.max(0, Number(row.count) || 0)

      current.count += count
      current.bytes += Math.max(0, Number(row.bytes) || 0)
      current.errors += Math.max(0, Number(row.errors) || 0)
      current.weighted_ms += Math.max(0, Number(row.avg_ms) || 0) * count

      rows.set(key, current)
    }
  }

  return [...rows.values()]
    .map((row) => ({
      kind: row.kind,
      feature: row.feature,
      source_route: row.source_route,
      dependency: row.dependency,
      count: row.count,
      bytes: row.bytes,
      mb: Number((row.bytes / 1024 / 1024).toFixed(4)),
      errors: row.errors,
      avg_ms: row.count
        ? Number((row.weighted_ms / row.count).toFixed(1))
        : 0,
    }))
    .sort((a, b) => b.bytes - a.bytes || b.count - a.count)
    .slice(0, MAX_DETAIL_ROWS)
}

function buildSnapshot(now = Date.now()) {
  const source = getSystemUsageSnapshot()
  const windowEnd = alignedWindowEnd(now)
  const windowStart = windowEnd - SNAPSHOT_MS

  const minutes = (source.recent_minutes || []).filter(
    (minute) =>
      Number(minute.started_at) >= windowStart &&
      Number(minute.started_at) < windowEnd
  )

  const totals = minutes.reduce(
    (result, minute) => {
      result.count += Math.max(0, Number(minute.count) || 0)
      result.bytes += Math.max(0, Number(minute.bytes) || 0)
      result.errors += Math.max(0, Number(minute.errors) || 0)
      return result
    },
    { count: 0, bytes: 0, errors: 0 }
  )

  return {
    windowStart,
    windowEnd,
    totals,
    payload: {
      version: 1,
      interval_minutes: 15,
      available_minutes: minutes.length,
      detail_limit: MAX_DETAIL_ROWS,
      monitor: source.monitor,
      top_rows: aggregateRows(minutes),
    },
  }
}

async function cleanupOldSnapshots(now = Date.now()) {
  if (now - lastCleanupAt < CLEANUP_MS) return

  const cutoff = new Date(now - RETENTION_MS).toISOString()

  const { error } = await supabase
    .from('system_usage_snapshots')
    .delete()
    .lt('window_end', cutoff)

  if (error) throw error
  lastCleanupAt = now
}

export async function persistSystemUsageSnapshot() {
  if (writing) return

  writing = true

  try {
    const snapshot = buildSnapshot()

    if (snapshot.windowEnd <= snapshot.windowStart) return

    const { error } = await supabase
      .from('system_usage_snapshots')
      .upsert(
        {
          window_start: new Date(snapshot.windowStart).toISOString(),
          window_end: new Date(snapshot.windowEnd).toISOString(),
          request_count: snapshot.totals.count,
          bytes: snapshot.totals.bytes,
          errors: snapshot.totals.errors,
          payload: snapshot.payload,
        },
        {
          onConflict: 'window_start,window_end',
        }
      )

    if (error) throw error

    await cleanupOldSnapshots()
  } catch (error) {
    console.error(
      'SYSTEM_USAGE_SNAPSHOT_ERROR:',
      error?.message || error
    )
  } finally {
    writing = false
  }
}

export function startSystemUsagePersistence() {
  if (startTimer || intervalTimer) return

  const delay =
    SNAPSHOT_MS - (Date.now() % SNAPSHOT_MS) + 1000

  startTimer = setTimeout(() => {
    startTimer = null
    void persistSystemUsageSnapshot()

    intervalTimer = setInterval(
      () => void persistSystemUsageSnapshot(),
      SNAPSHOT_MS
    )

    intervalTimer.unref?.()
  }, delay)

  startTimer.unref?.()
}
