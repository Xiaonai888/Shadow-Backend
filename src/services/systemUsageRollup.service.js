import { supabase } from '../config/supabase.js'

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS
const DETAIL_RETENTION_MS = 7 * DAY_MS
const HOURLY_RETENTION_MS = 30 * DAY_MS
const DAILY_RETENTION_MS = 365 * DAY_MS
const MONTHLY_RETENTION_MS = 3 * 365 * DAY_MS
const PAGE_SIZE = 1000
const MAX_TOP_ROWS = 100

function safeNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(0, number) : 0
}

function toMb(bytes) {
  return Number((safeNumber(bytes) / 1024 / 1024).toFixed(4))
}

function floorHour(ms) {
  return Math.floor(ms / HOUR_MS) * HOUR_MS
}

function floorDay(ms) {
  return Math.floor(ms / DAY_MS) * DAY_MS
}

function floorMonth(ms) {
  const date = new Date(ms)
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)
}

function nextBucket(ms, granularity) {
  if (granularity === 'hour') return ms + HOUR_MS
  if (granularity === 'day') return ms + DAY_MS

  const date = new Date(ms)
  return Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth() + 1,
    1
  )
}

function bucketStart(ms, granularity) {
  if (granularity === 'hour') return floorHour(ms)
  if (granularity === 'day') return floorDay(ms)
  return floorMonth(ms)
}

function detailKey(row) {
  return [
    row.kind || 'unknown',
    row.feature || 'unknown',
    row.source_route || 'UNKNOWN',
    row.dependency || 'UNKNOWN',
  ].join('\u001f')
}

function mergeDetailRows(target, rows = []) {
  for (const row of rows) {
    const key = detailKey(row)
    const current = target.get(key) || {
      kind: row.kind || 'unknown',
      feature: row.feature || 'unknown',
      source_route: row.source_route || 'UNKNOWN',
      dependency: row.dependency || 'UNKNOWN',
      count: 0,
      bytes: 0,
      errors: 0,
      weighted_ms: 0,
    }

    const count = safeNumber(row.count)
    current.count += count
    current.bytes += safeNumber(row.bytes)
    current.errors += safeNumber(row.errors)
    current.weighted_ms += safeNumber(row.avg_ms) * count
    target.set(key, current)
  }
}

function serializeDetailRows(map) {
  return [...map.values()]
    .map((row) => ({
      kind: row.kind,
      feature: row.feature,
      source_route: row.source_route,
      dependency: row.dependency,
      count: row.count,
      bytes: row.bytes,
      mb: toMb(row.bytes),
      errors: row.errors,
      avg_ms: row.count
        ? Number((row.weighted_ms / row.count).toFixed(1))
        : 0,
    }))
    .sort((a, b) => b.bytes - a.bytes || b.count - a.count)
    .slice(0, MAX_TOP_ROWS)
}

async function loadPaged({
  table,
  select,
  timeColumn,
  fromIso,
  toIso,
  granularity = null,
}) {
  const rows = []

  for (let offset = 0; ; offset += PAGE_SIZE) {
    let query = supabase
      .from(table)
      .select(select)
      .gte(timeColumn, fromIso)
      .lt(timeColumn, toIso)
      .order(timeColumn, { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1)

    if (granularity) {
      query = query.eq('granularity', granularity)
    }

    const { data, error } = await query
    if (error) throw error

    const page = Array.isArray(data) ? data : []
    rows.push(...page)

    if (page.length < PAGE_SIZE) break
  }

  return rows
}

async function loadSnapshotRows(fromMs, toMs) {
  return loadPaged({
    table: 'system_usage_snapshots',
    select:
      'window_start,window_end,request_count,bytes,errors,payload',
    timeColumn: 'window_start',
    fromIso: new Date(fromMs).toISOString(),
    toIso: new Date(toMs).toISOString(),
  })
}

async function loadRollupRows(granularity, fromMs, toMs) {
  return loadPaged({
    table: 'system_usage_rollups',
    select:
      'granularity,bucket_start,bucket_end,request_count,bytes,errors,source_rows,payload',
    timeColumn: 'bucket_start',
    fromIso: new Date(fromMs).toISOString(),
    toIso: new Date(toMs).toISOString(),
    granularity,
  })
}

function groupSourceRows(rows, granularity, sourceType) {
  const groups = new Map()

  for (const row of rows) {
    const rawStart =
      sourceType === 'snapshot'
        ? row.window_start
        : row.bucket_start
    const startMs = new Date(rawStart).getTime()

    if (!Number.isFinite(startMs)) continue

    const start = bucketStart(startMs, granularity)
    const end = nextBucket(start, granularity)
    const key = `${granularity}:${start}`

    const current = groups.get(key) || {
      granularity,
      bucket_start: new Date(start).toISOString(),
      bucket_end: new Date(end).toISOString(),
      request_count: 0,
      bytes: 0,
      errors: 0,
      source_rows: 0,
      details: new Map(),
    }

    current.request_count += safeNumber(row.request_count)
    current.bytes += safeNumber(row.bytes)
    current.errors += safeNumber(row.errors)
    current.source_rows += 1
    mergeDetailRows(
      current.details,
      row?.payload?.top_rows || []
    )

    groups.set(key, current)
  }

  return [...groups.values()].map((group) => ({
    granularity: group.granularity,
    bucket_start: group.bucket_start,
    bucket_end: group.bucket_end,
    request_count: group.request_count,
    bytes: group.bytes,
    errors: group.errors,
    source_rows: group.source_rows,
    payload: {
      version: 1,
      granularity: group.granularity,
      top_rows: serializeDetailRows(group.details),
    },
  }))
}

async function upsertRollups(rows) {
  if (!rows.length) return 0

  const { error } = await supabase
    .from('system_usage_rollups')
    .upsert(rows, {
      onConflict: 'granularity,bucket_start,bucket_end',
    })

  if (error) throw error
  return rows.length
}

async function rollupSnapshotsToHours(now) {
  const from = floorHour(now - 8 * DAY_MS)
  const to = floorHour(now)

  if (to <= from) return 0

  const rows = await loadSnapshotRows(from, to)
  const groups = groupSourceRows(rows, 'hour', 'snapshot')
  return upsertRollups(groups)
}

async function rollupHoursToDays(now) {
  const from = floorDay(now - 32 * DAY_MS)
  const to = floorDay(now)

  if (to <= from) return 0

  const rows = await loadRollupRows('hour', from, to)
  const groups = groupSourceRows(rows, 'day', 'rollup')
  return upsertRollups(groups)
}

async function rollupDaysToMonths(now) {
  const date = new Date(now)
  const from = Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth() - 13,
    1
  )
  const to = floorMonth(now)

  if (to <= from) return 0

  const rows = await loadRollupRows('day', from, to)
  const groups = groupSourceRows(rows, 'month', 'rollup')
  return upsertRollups(groups)
}

async function deleteOlderThan(table, column, cutoffIso, granularity) {
  let query = supabase
    .from(table)
    .delete()
    .lt(column, cutoffIso)

  if (granularity) {
    query = query.eq('granularity', granularity)
  }

  const { error } = await query
  if (error) throw error
}

async function cleanupRetention(now) {
  await deleteOlderThan(
    'system_usage_snapshots',
    'window_end',
    new Date(now - DETAIL_RETENTION_MS).toISOString()
  )

  await deleteOlderThan(
    'system_usage_rollups',
    'bucket_end',
    new Date(now - HOURLY_RETENTION_MS).toISOString(),
    'hour'
  )

  await deleteOlderThan(
    'system_usage_rollups',
    'bucket_end',
    new Date(now - DAILY_RETENTION_MS).toISOString(),
    'day'
  )

  await deleteOlderThan(
    'system_usage_rollups',
    'bucket_end',
    new Date(now - MONTHLY_RETENTION_MS).toISOString(),
    'month'
  )
}

export async function runSystemUsageRetention(
  now = Date.now()
) {
  const result = {
    hourly: 0,
    daily: 0,
    monthly: 0,
    cleaned: false,
  }

  result.hourly = await rollupSnapshotsToHours(now)
  result.daily = await rollupHoursToDays(now)
  result.monthly = await rollupDaysToMonths(now)

  await cleanupRetention(now)
  result.cleaned = true

  return result
}

function normalizeArchivedRows(rows, source) {
  return rows.map((row) => ({
    window_start: row.bucket_start,
    window_end: row.bucket_end,
    request_count: safeNumber(row.request_count),
    bytes: safeNumber(row.bytes),
    errors: safeNumber(row.errors),
    payload: row.payload || {},
    source,
  }))
}

export async function loadArchivedUsageHistory({
  from,
  to,
  now = Date.now(),
} = {}) {
  const fromMs = new Date(from || '').getTime()
  const toMs = new Date(to || '').getTime()

  if (
    !Number.isFinite(fromMs) ||
    !Number.isFinite(toMs) ||
    toMs <= fromMs
  ) {
    return []
  }

  const detailCutoff = now - DETAIL_RETENTION_MS
  const hourlyCutoff = now - HOURLY_RETENTION_MS
  const dailyCutoff = now - DAILY_RETENTION_MS
  const parts = []

  if (fromMs < dailyCutoff) {
    const end = Math.min(toMs, dailyCutoff)
    if (end > fromMs) {
      const rows = await loadRollupRows(
        'month',
        fromMs,
        end
      )
      parts.push(
        ...normalizeArchivedRows(rows, 'month')
      )
    }
  }

  if (toMs > dailyCutoff && fromMs < hourlyCutoff) {
    const start = Math.max(fromMs, dailyCutoff)
    const end = Math.min(toMs, hourlyCutoff)

    if (end > start) {
      const rows = await loadRollupRows(
        'day',
        start,
        end
      )
      parts.push(
        ...normalizeArchivedRows(rows, 'day')
      )
    }
  }

  if (toMs > hourlyCutoff && fromMs < detailCutoff) {
    const start = Math.max(fromMs, hourlyCutoff)
    const end = Math.min(toMs, detailCutoff)

    if (end > start) {
      const rows = await loadRollupRows(
        'hour',
        start,
        end
      )
      parts.push(
        ...normalizeArchivedRows(rows, 'hour')
      )
    }
  }

  return parts.sort(
    (a, b) =>
      new Date(a.window_start).getTime() -
      new Date(b.window_start).getTime()
  )
}

export function getSystemUsageRetentionPolicy() {
  return {
    detail_days: 7,
    hourly_days: 30,
    daily_days: 365,
    monthly_days: 1095,
    unresolved_incidents_delete: false,
  }
}
