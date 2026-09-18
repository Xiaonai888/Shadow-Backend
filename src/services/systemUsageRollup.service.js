import { supabase } from '../config/supabase.js'

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS
const DETAIL_RETENTION_MS = 7 * DAY_MS
const HOURLY_RETENTION_MS = 30 * DAY_MS
const PAGE_SIZE = 1000
const UPSERT_BATCH = 250
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

  return Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    1
  )
}

function shiftUtcYears(ms, years) {
  const date = new Date(ms)

  return Date.UTC(
    date.getUTCFullYear() + years,
    date.getUTCMonth(),
    date.getUTCDate(),
    date.getUTCHours(),
    date.getUTCMinutes(),
    date.getUTCSeconds(),
    date.getUTCMilliseconds()
  )
}

function nextBucket(ms, granularity) {
  if (granularity === 'hour') {
    return ms + HOUR_MS
  }

  if (granularity === 'day') {
    return ms + DAY_MS
  }

  const date = new Date(ms)

  return Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth() + 1,
    1
  )
}

function bucketStart(ms, granularity) {
  if (granularity === 'hour') {
    return floorHour(ms)
  }

  if (granularity === 'day') {
    return floorDay(ms)
  }

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
    current.weighted_ms +=
      safeNumber(row.avg_ms) * count

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
        ? Number(
            (
              row.weighted_ms /
              row.count
            ).toFixed(1)
          )
        : 0,
    }))
    .sort(
      (a, b) =>
        b.bytes - a.bytes ||
        b.count - a.count
    )
    .slice(0, MAX_TOP_ROWS)
}

async function loadEligibleRows({
  table,
  select,
  endColumn,
  boundaryMs,
  granularity = null,
}) {
  const rows = []
  const boundaryIso =
    new Date(boundaryMs).toISOString()

  for (
    let offset = 0;
    ;
    offset += PAGE_SIZE
  ) {
    let query = supabase
      .from(table)
      .select(select)
      .lte(endColumn, boundaryIso)
      .order(endColumn, {
        ascending: true,
      })
      .range(
        offset,
        offset + PAGE_SIZE - 1
      )

    if (granularity) {
      query = query.eq(
        'granularity',
        granularity
      )
    }

    const { data, error } =
      await query

    if (error) throw error

    const page =
      Array.isArray(data)
        ? data
        : []

    rows.push(...page)

    if (page.length < PAGE_SIZE) {
      break
    }
  }

  return rows
}

async function loadSnapshotRowsBefore(
  boundaryMs
) {
  return loadEligibleRows({
    table: 'system_usage_snapshots',
    select:
      'window_start,window_end,request_count,bytes,errors,payload',
    endColumn: 'window_end',
    boundaryMs,
  })
}

async function loadRollupRowsBefore(
  granularity,
  boundaryMs
) {
  return loadEligibleRows({
    table: 'system_usage_rollups',
    select:
      'granularity,bucket_start,bucket_end,request_count,bytes,errors,source_rows,payload',
    endColumn: 'bucket_end',
    boundaryMs,
    granularity,
  })
}

async function loadRollupRowsOverlap(
  granularity,
  fromMs,
  toMs
) {
  if (toMs <= fromMs) {
    return []
  }

  const rows = []
  const fromIso =
    new Date(fromMs).toISOString()
  const toIso =
    new Date(toMs).toISOString()

  for (
    let offset = 0;
    ;
    offset += PAGE_SIZE
  ) {
    const { data, error } =
      await supabase
        .from(
          'system_usage_rollups'
        )
        .select(
          'granularity,bucket_start,bucket_end,request_count,bytes,errors,source_rows,payload'
        )
        .eq(
          'granularity',
          granularity
        )
        .gt(
          'bucket_end',
          fromIso
        )
        .lt(
          'bucket_start',
          toIso
        )
        .order(
          'bucket_start',
          { ascending: true }
        )
        .range(
          offset,
          offset + PAGE_SIZE - 1
        )

    if (error) throw error

    const page =
      Array.isArray(data)
        ? data
        : []

    rows.push(...page)

    if (
      page.length <
      PAGE_SIZE
    ) {
      break
    }
  }

  return rows
}

function groupSourceRows(
  rows,
  granularity,
  sourceType
) {
  const groups = new Map()

  for (const row of rows) {
    const rawStart =
      sourceType === 'snapshot'
        ? row.window_start
        : row.bucket_start

    const startMs =
      new Date(
        rawStart
      ).getTime()

    if (!Number.isFinite(startMs)) {
      continue
    }

    const start =
      bucketStart(
        startMs,
        granularity
      )

    const end =
      nextBucket(
        start,
        granularity
      )

    const key =
      `${granularity}:${start}`

    const current =
      groups.get(key) || {
        granularity,
        bucket_start:
          new Date(
            start
          ).toISOString(),
        bucket_end:
          new Date(
            end
          ).toISOString(),
        request_count: 0,
        bytes: 0,
        errors: 0,
        source_rows: 0,
        details: new Map(),
      }

    current.request_count +=
      safeNumber(
        row.request_count
      )

    current.bytes +=
      safeNumber(row.bytes)

    current.errors +=
      safeNumber(row.errors)

    current.source_rows +=
      sourceType === 'snapshot'
        ? 1
        : Math.max(
            1,
            Math.floor(
              safeNumber(
                row.source_rows
              )
            )
          )

    mergeDetailRows(
      current.details,
      row?.payload
        ?.top_rows || []
    )

    groups.set(
      key,
      current
    )
  }

  return [...groups.values()]
    .map((group) => ({
      granularity:
        group.granularity,
      bucket_start:
        group.bucket_start,
      bucket_end:
        group.bucket_end,
      request_count:
        group.request_count,
      bytes:
        group.bytes,
      errors:
        group.errors,
      source_rows:
        group.source_rows,
      payload: {
        version: 2,
        granularity:
          group.granularity,
        top_rows:
          serializeDetailRows(
            group.details
          ),
      },
    }))
    .sort(
      (a, b) =>
        new Date(
          a.bucket_start
        ).getTime() -
        new Date(
          b.bucket_start
        ).getTime()
    )
}

async function upsertRollups(rows) {
  if (!rows.length) {
    return 0
  }

  for (
    let index = 0;
    index < rows.length;
    index += UPSERT_BATCH
  ) {
    const batch =
      rows.slice(
        index,
        index + UPSERT_BATCH
      )

    const { error } =
      await supabase
        .from(
          'system_usage_rollups'
        )
        .upsert(
          batch,
          {
            onConflict:
              'granularity,bucket_start,bucket_end',
          }
        )

    if (error) throw error
  }

  return rows.length
}

async function deleteEligibleRows({
  table,
  endColumn,
  boundaryMs,
  granularity = null,
}) {
  let query = supabase
    .from(table)
    .delete()
    .lte(
      endColumn,
      new Date(
        boundaryMs
      ).toISOString()
    )

  if (granularity) {
    query = query.eq(
      'granularity',
      granularity
    )
  }

  const { error } =
    await query

  if (error) throw error
}

async function migrateTier({
  sourceTable,
  sourceGranularity = null,
  targetGranularity,
  sourceType,
  boundaryMs,
}) {
  const rows =
    sourceType === 'snapshot'
      ? await loadSnapshotRowsBefore(
          boundaryMs
        )
      : await loadRollupRowsBefore(
          sourceGranularity,
          boundaryMs
        )

  if (!rows.length) {
    return {
      source_rows: 0,
      target_rows: 0,
      deleted: false,
    }
  }

  const groups =
    groupSourceRows(
      rows,
      targetGranularity,
      sourceType
    )

  await upsertRollups(
    groups
  )

  await deleteEligibleRows({
    table: sourceTable,
    endColumn:
      sourceType === 'snapshot'
        ? 'window_end'
        : 'bucket_end',
    boundaryMs,
    granularity:
      sourceGranularity,
  })

  return {
    source_rows: rows.length,
    target_rows: groups.length,
    deleted: true,
  }
}

function retentionBoundaries(
  now = Date.now()
) {
  const detailCutoff =
    now -
    DETAIL_RETENTION_MS

  const hourlyCutoff =
    now -
    HOURLY_RETENTION_MS

  const oneYearAgo =
    shiftUtcYears(
      now,
      -1
    )

  const threeYearsAgo =
    shiftUtcYears(
      now,
      -3
    )

  return {
    detail:
      floorHour(
        detailCutoff
      ),
    hourly:
      floorDay(
        hourlyCutoff
      ),
    daily:
      floorMonth(
        oneYearAgo
      ),
    monthly:
      floorMonth(
        threeYearsAgo
      ),
  }
}

async function deleteExpiredMonthly(
  boundaryMs
) {
  await deleteEligibleRows({
    table:
      'system_usage_rollups',
    endColumn:
      'bucket_end',
    boundaryMs,
    granularity:
      'month',
  })
}

export async function runSystemUsageRetention(
  now = Date.now()
) {
  const boundaries =
    retentionBoundaries(
      now
    )

  const result = {
    boundaries: {
      detail:
        new Date(
          boundaries.detail
        ).toISOString(),
      hourly:
        new Date(
          boundaries.hourly
        ).toISOString(),
      daily:
        new Date(
          boundaries.daily
        ).toISOString(),
      monthly:
        new Date(
          boundaries.monthly
        ).toISOString(),
    },
    hourly: null,
    daily: null,
    monthly: null,
    monthly_cleanup: false,
  }

  result.hourly =
    await migrateTier({
      sourceTable:
        'system_usage_snapshots',
      targetGranularity:
        'hour',
      sourceType:
        'snapshot',
      boundaryMs:
        boundaries.detail,
    })

  result.daily =
    await migrateTier({
      sourceTable:
        'system_usage_rollups',
      sourceGranularity:
        'hour',
      targetGranularity:
        'day',
      sourceType:
        'rollup',
      boundaryMs:
        boundaries.hourly,
    })

  result.monthly =
    await migrateTier({
      sourceTable:
        'system_usage_rollups',
      sourceGranularity:
        'day',
      targetGranularity:
        'month',
      sourceType:
        'rollup',
      boundaryMs:
        boundaries.daily,
    })

  await deleteExpiredMonthly(
    boundaries.monthly
  )

  result.monthly_cleanup = true

  return result
}

function normalizeArchivedRows(
  rows,
  granularity
) {
  const source =
    `rollup_${granularity}`

  return rows.map((row) => ({
    window_start:
      row.bucket_start,
    window_end:
      row.bucket_end,
    request_count:
      safeNumber(
        row.request_count
      ),
    bytes:
      safeNumber(row.bytes),
    errors:
      safeNumber(row.errors),
    payload:
      row.payload || {},
    source,
  }))
}

export async function loadArchivedUsageHistory({
  from,
  to,
  now = Date.now(),
} = {}) {
  const fromMs =
    new Date(
      from || ''
    ).getTime()

  const toMs =
    new Date(
      to || ''
    ).getTime()

  if (
    !Number.isFinite(
      fromMs
    ) ||
    !Number.isFinite(
      toMs
    ) ||
    toMs <= fromMs
  ) {
    return []
  }

  const boundaries =
    retentionBoundaries(
      now
    )

  const parts = []

  const monthEnd =
    Math.min(
      toMs,
      boundaries.daily
    )

  if (
    fromMs <
    monthEnd
  ) {
    const rows =
      await loadRollupRowsOverlap(
        'month',
        fromMs,
        monthEnd
      )

    parts.push(
      ...normalizeArchivedRows(
        rows,
        'month'
      )
    )
  }

  const dayStart =
    Math.max(
      fromMs,
      boundaries.daily
    )

  const dayEnd =
    Math.min(
      toMs,
      boundaries.hourly
    )

  if (
    dayEnd >
    dayStart
  ) {
    const rows =
      await loadRollupRowsOverlap(
        'day',
        dayStart,
        dayEnd
      )

    parts.push(
      ...normalizeArchivedRows(
        rows,
        'day'
      )
    )
  }

  const hourStart =
    Math.max(
      fromMs,
      boundaries.hourly
    )

  const hourEnd =
    Math.min(
      toMs,
      boundaries.detail
    )

  if (
    hourEnd >
    hourStart
  ) {
    const rows =
      await loadRollupRowsOverlap(
        'hour',
        hourStart,
        hourEnd
      )

    parts.push(
      ...normalizeArchivedRows(
        rows,
        'hour'
      )
    )
  }

  return parts.sort(
    (a, b) =>
      new Date(
        a.window_start
      ).getTime() -
      new Date(
        b.window_start
      ).getTime()
  )
}

export function getSystemUsageRetentionPolicy() {
  return {
    detail_days: 7,
    hourly_days: 30,
    daily_days: 365,
    monthly_days: 1095,
    daily_policy:
      'one_calendar_year',
    monthly_policy:
      'three_calendar_years',
    boundaries:
      'completed_utc_buckets',
    unresolved_incidents_delete:
      false,
  }
}
