import { gzipSync, gunzipSync } from 'node:zlib'
import { registerRuntimeInspectable } from './runtimeMemoryInspector.service.js'
import { summarizeResourceCostMinuteAttribution } from './resourceCostAttributionMinute.service.js'

const LIVE_WINDOW_MS = 15 * 1000
const MINUTE_WINDOW_MS = 60 * 1000
const MAX_LIVE_WINDOWS = 16
const MAX_MINUTE_WINDOWS = 120
const MAX_KEYS_PER_WINDOW = 500
const MAX_ROWS_PER_SNAPSHOT = 100
const MAX_ERROR_ROWS_PER_SNAPSHOT = 20
const MAX_ARCHIVE_INFLATED_BYTES = 8 * 1024 * 1024

let liveWindow = createWindow(LIVE_WINDOW_MS)
let minuteWindow = createWindow(MINUTE_WINDOW_MS)

const liveHistory = []
const minuteHistory = []

const monitorStats = {
  events_recorded: 0,
  dropped_keys: 0,
  processing_ns: 0n,
  started_at: Date.now(),
  minute_archive_capture_failures: 0,
}

function floorWindow(now, intervalMs) {
  return Math.floor(now / intervalMs) * intervalMs
}

function createWindow(intervalMs, now = Date.now()) {
  const startedAt = floorWindow(now, intervalMs)

  return {
    interval_ms: intervalMs,
    started_at: startedAt,
    ended_at: startedAt + intervalMs,
    rows: new Map(),
    overflow_events: 0,
  }
}

function clean(value, maxLength = 500) {
  return String(value || '').trim().slice(0, maxLength)
}

function splitRoute(value) {
  const route = clean(value, 600)

  if (!route || route === 'BACKGROUND') {
    return {
      source_route: 'BACKGROUND',
      source_method: 'BACKGROUND',
      source_path: 'BACKGROUND',
    }
  }

  const firstSpace = route.indexOf(' ')

  if (firstSpace <= 0) {
    return {
      source_route: route,
      source_method: 'UNKNOWN',
      source_path: route,
    }
  }

  return {
    source_route: route,
    source_method: clean(route.slice(0, firstSpace), 16).toUpperCase(),
    source_path: clean(route.slice(firstSpace + 1), 500) || '/',
  }
}

function featureFromPath(path) {
  if (path === 'BACKGROUND') return 'background'

  const segments = clean(path, 500)
    .split('?')[0]
    .split('/')
    .filter(Boolean)

  if (segments[0] === 'api' && segments[1]) {
    return segments[1].toLowerCase()
  }

  return (segments[0] || 'root').toLowerCase()
}

function parseExternalTarget(value) {
  const target = clean(value, 700)
  const firstSpace = target.indexOf(' ')
  const secondSpace = firstSpace >= 0
    ? target.indexOf(' ', firstSpace + 1)
    : -1

  if (firstSpace <= 0 || secondSpace <= firstSpace) {
    return {
      dependency: 'UNKNOWN',
      operation_method: 'UNKNOWN',
      target_path: target || '/',
    }
  }

  return {
    dependency: clean(target.slice(0, firstSpace), 160).toUpperCase(),
    operation_method: clean(
      target.slice(firstSpace + 1, secondSpace),
      16
    ).toUpperCase(),
    target_path: clean(target.slice(secondSpace + 1), 500) || '/',
  }
}

function normalizeTrafficDirection(value, fallback = 'unknown') {
  const direction = String(value || '').trim().toLowerCase()
  return direction === 'inbound' || direction === 'outbound'
    ? direction
    : fallback
}

function normalizeSample(input = {}) {
  const kind = input.kind === 'external_request'
    ? 'external_request'
    : 'http_response'

  const rawKey = clean(input.key, 1400)

  if (kind === 'external_request') {
    const separator = rawKey.indexOf(' -> ')
    const source = separator >= 0
      ? rawKey.slice(0, separator)
      : 'BACKGROUND'
    const target = separator >= 0
      ? rawKey.slice(separator + 4)
      : rawKey

    const route = splitRoute(source)
    const external = parseExternalTarget(target)

      return {
      kind,
      direction: normalizeTrafficDirection(input.direction),
      feature: featureFromPath(route.source_path),
      ...route,
      ...external,
      bytes: Math.max(0, Number(input.bytes) || 0),
      errors: input.error ? 1 : 0,
      duration_ms: Math.max(0, Number(input.duration_ms) || 0),
    }
  }

  const route = splitRoute(rawKey)

    return {
    kind,
    direction: normalizeTrafficDirection(input.direction, 'outbound'),
    feature: featureFromPath(route.source_path),
    ...route,
    dependency: 'CLIENT',
    operation_method: route.source_method,
    target_path: route.source_path,
    bytes: Math.max(0, Number(input.bytes) || 0),
    errors: input.error ? 1 : 0,
    duration_ms: Math.max(0, Number(input.duration_ms) || 0),
  }
}

function metricKey(sample) {
  return [
    sample.kind,
    sample.direction,
    sample.feature,
    sample.source_route,
    sample.dependency,
    sample.operation_method,
    sample.target_path,
  ].join('\u001f')
}

function overflowSample(sample) {
  return {
    ...sample,
    feature: 'overflow',
    source_route: 'OVERFLOW',
    source_method: 'OVERFLOW',
    source_path: 'OVERFLOW',
    dependency: sample.dependency || 'UNKNOWN',
    operation_method: 'OVERFLOW',
    target_path: 'OVERFLOW',
  }
}

function addToWindow(window, sample) {
  let safeSample = sample
  let key = metricKey(safeSample)

  if (
    !window.rows.has(key)
    && window.rows.size >= MAX_KEYS_PER_WINDOW
  ) {
    safeSample = overflowSample(sample)
    key = metricKey(safeSample)
    window.overflow_events += 1
    monitorStats.dropped_keys += 1
  }

  const current = window.rows.get(key) || {
    kind: safeSample.kind,
    direction: safeSample.direction,
    feature: safeSample.feature,
    source_route: safeSample.source_route,
    source_method: safeSample.source_method,
    source_path: safeSample.source_path,
    dependency: safeSample.dependency,
    operation_method: safeSample.operation_method,
    target_path: safeSample.target_path,
    count: 0,
    bytes: 0,
    errors: 0,
    duration_ms: 0,
  }

  current.count += 1
  current.bytes += safeSample.bytes
  current.errors += safeSample.errors
  current.duration_ms += safeSample.duration_ms

  window.rows.set(key, current)
}

function snapshotRows(window) {
  const ranked = [...window.rows.values()]
    .map((row) => ({
      kind: row.kind,
      direction: row.direction,
      feature: row.feature,
      source_route: row.source_route,
      source_method: row.source_method,
      source_path: row.source_path,
      dependency: row.dependency,
      operation_method: row.operation_method,
      target_path: row.target_path,
      count: row.count,
      bytes: row.bytes,
      mb: Number((row.bytes / 1024 / 1024).toFixed(4)),
      errors: row.errors,
      avg_ms: row.count
        ? Number((row.duration_ms / row.count).toFixed(1))
        : 0,
    }))
    .sort((a, b) => b.count - a.count || b.bytes - a.bytes)

  if (ranked.length <= MAX_ROWS_PER_SNAPSHOT) return ranked

  const prioritizedErrors = ranked
    .filter((row) => row.errors > 0)
    .sort((a, b) => b.errors - a.errors || b.count - a.count)
    .slice(0, MAX_ERROR_ROWS_PER_SNAPSHOT)

  const selected = new Set(prioritizedErrors.map(metricKey))
  for (const row of ranked) {
    if (selected.size >= MAX_ROWS_PER_SNAPSHOT) break
    selected.add(metricKey(row))
  }

  return ranked.filter((row) => selected.has(metricKey(row)))
}

function summarize(window) {
  let count = 0
  let bytes = 0
  let errors = 0
  const bySource = new Map()

  for (const row of window.rows.values()) {
    count += row.count
    bytes += row.bytes
    errors += row.errors

    const kind = row.kind || 'unknown'
    const dependency = row.dependency || 'UNKNOWN'
    const key = `${kind}\u001f${dependency}`
    const current = bySource.get(key) || {
      kind,
      dependency,
      count: 0,
      bytes: 0,
      errors: 0,
    }

    current.count += row.count
    current.bytes += row.bytes
    current.errors += row.errors
    bySource.set(key, current)
  }

  const rows = snapshotRows(window)
  const listed = rows.reduce((sum, row) => ({
    count: sum.count + row.count,
    bytes: sum.bytes + row.bytes,
    errors: sum.errors + row.errors,
  }), { count: 0, bytes: 0, errors: 0 })

  return {
    started_at: window.started_at,
    ended_at: window.ended_at,
    interval_seconds: window.interval_ms / 1000,
    count,
    bytes,
    mb: Number((bytes / 1024 / 1024).toFixed(4)),
     errors,
    rows,
    ...(window.interval_ms === MINUTE_WINDOW_MS
      ? { resource_cost_attribution: summarizeResourceCostMinuteAttribution(window.rows.values()) }
      : {}),
    source_totals: [...bySource.values()].sort(
      (a, b) => b.count - a.count || b.bytes - a.bytes
    ),
    detail_coverage: {
      detail_rows: rows.length,
      measured_groups: window.rows.size,
      omitted_groups: Math.max(0, window.rows.size - rows.length),
      omitted_events: Math.max(0, count - listed.count),
      omitted_bytes: Math.max(0, bytes - listed.bytes),
      omitted_errors: Math.max(0, errors - listed.errors),
      overflow_events: window.overflow_events,
    },
  }
}

function captureMinuteArchive(window) {
  const rows = [...window.rows.values()]
    .map((row) => ({
      kind: row.kind,
      direction: row.direction,
      feature: row.feature,
      source_route: row.source_route,
      source_method: row.source_method,
      source_path: row.source_path,
      dependency: row.dependency,
      operation_method: row.operation_method,
      target_path: row.target_path,
      count: row.count,
      bytes: row.bytes,
      errors: row.errors,
      duration_ms: row.duration_ms,
    }))
    .sort((a, b) =>
      metricKey(a).localeCompare(metricKey(b)))

  const serialized = Buffer.from(JSON.stringify(rows), 'utf8')
  if (serialized.length > MAX_ARCHIVE_INFLATED_BYTES) {
    throw new RangeError('Minute usage archive exceeded its memory safety limit.')
  }
  return gzipSync(serialized, { level: 1 })
}

function archiveMinuteWindow(window) {
  const result = summarize(window)
  try {
    result.minute_archive = captureMinuteArchive(window)
    result.minute_archive_status = 'complete_group_snapshot'
  } catch (error) {
    result.minute_archive = null
    result.minute_archive_status = 'capture_failed'
    monitorStats.minute_archive_capture_failures += 1
    console.error('SYSTEM USAGE MINUTE ARCHIVE CAPTURE ERROR:', String(error?.message || error))
  }
  return result
}

function decodeMinuteArchive(window) {
  if (!Buffer.isBuffer(window?.minute_archive)) {
    throw new Error('Minute usage archive is not available.')
  }
  const raw = gunzipSync(window.minute_archive, {
    maxOutputLength: MAX_ARCHIVE_INFLATED_BYTES,
  })
  const rows = JSON.parse(raw.toString('utf8'))
  if (!Array.isArray(rows) || rows.length !== window.detail_coverage.measured_groups) {
    throw new Error('Minute usage archive grouped-row count mismatch.')
  }
  const observed = rows.reduce((total, row) => ({
    count: total.count + row.count,
    bytes: total.bytes + row.bytes,
    errors: total.errors + row.errors,
  }), { count: 0, bytes: 0, errors: 0 })
  if (observed.count !== window.count || observed.bytes !== window.bytes ||
      observed.errors !== window.errors) {
    throw new Error('Minute usage archive totals mismatch.')
  }
  return rows
}

function pushBounded(history, item, maxItems) {
  history.push(item)

  while (history.length > maxItems) {
    history.shift()
  }
}

function rotateWindows(now = Date.now()) {
  if (now >= liveWindow.ended_at) {
    if (liveWindow.rows.size > 0) {
      pushBounded(
        liveHistory,
        summarize(liveWindow),
        MAX_LIVE_WINDOWS
      )
    }

    liveWindow = createWindow(LIVE_WINDOW_MS, now)
  }

  if (now >= minuteWindow.ended_at) {
    if (minuteWindow.rows.size > 0) {
      pushBounded(
        minuteHistory,
        archiveMinuteWindow(minuteWindow),
        MAX_MINUTE_WINDOWS
      )
    }

    minuteWindow = createWindow(MINUTE_WINDOW_MS, now)
  }
}

function cloneHistory(items) {
  return items.map((item) => ({
    ...item,
    minute_archive: undefined,
    minute_archive_status: item.minute_archive_status || 'not_applicable',
    rows: item.rows.map((row) => ({ ...row })),
    source_totals: item.source_totals.map((row) => ({ ...row })),
    resource_cost_attribution: item.resource_cost_attribution
      ? {
          ...item.resource_cost_attribution,
          rows: item.resource_cost_attribution.rows.map((row) => ({ ...row })),
          totals: { ...item.resource_cost_attribution.totals },
          coverage: { ...item.resource_cost_attribution.coverage },
        }
      : null,
    detail_coverage: { ...item.detail_coverage },
  }))
}

export function getSystemUsageArchiveMinutes({ from, to } = {}) {
  const start = new Date(from).getTime()
  const end = new Date(to).getTime()
  if (!Number.isFinite(start) || !Number.isFinite(end) ||
      end <= start || end - start > 2 * 60 * 60 * 1000) {
    throw new RangeError('Minute usage archive range must be within two hours.')
  }
  rotateWindows()
  const windows = minuteHistory
    .filter((window) => window.started_at >= start && window.ended_at <= end)
    .map((window) => ({
      from: new Date(window.started_at).toISOString(),
      to: new Date(window.ended_at).toISOString(),
      rows: decodeMinuteArchive(window),
      totals: { count: window.count, bytes: window.bytes, errors: window.errors },
      coverage: {
        grouped_metrics_preserved: window.minute_archive_status === 'complete_group_snapshot' &&
          window.detail_coverage.overflow_events === 0,
        overflow_events: window.detail_coverage.overflow_events,
        stored_group_rows: window.detail_coverage.measured_groups,
        event_level_complete: false,
        source: 'grouped_monitor_counters',
      },
    }))

  return {
    from: new Date(start).toISOString(),
    to: new Date(end).toISOString(),
    windows,
    coverage: {
      returned_minute_windows: windows.length,
      requested_minute_windows: Math.ceil((end - start) / MINUTE_WINDOW_MS),
      event_level_complete: false,
      all_group_dimensions_preserved: windows.length > 0 &&
        windows.every((window) => window.coverage.grouped_metrics_preserved),
      history_is_memory_only: true,
    },
  }
}

export function recordSystemUsage(input = {}) {
  const startedAt = process.hrtime.bigint()

  try {
    rotateWindows()

    const sample = normalizeSample(input)

    addToWindow(liveWindow, sample)
    addToWindow(minuteWindow, sample)
    monitorStats.events_recorded += 1
  } finally {
    monitorStats.processing_ns +=
      process.hrtime.bigint() - startedAt
  }
}

export function getSystemUsageCurrentSnapshot() {
  rotateWindows()

  return {
    generated_at: Date.now(),
    monitor: {
      events_recorded: monitorStats.events_recorded,
      dropped_keys: monitorStats.dropped_keys,
      minute_archive_capture_failures: monitorStats.minute_archive_capture_failures,
      processing_ms: Number(monitorStats.processing_ns / 1_000_000n),
      started_at: monitorStats.started_at,
    },
    live: summarize(liveWindow),
    minute: summarize(minuteWindow),
  }
}

export function getSystemUsageSnapshot() {
  rotateWindows()

  return {
    generated_at: Date.now(),
    monitor: {
      events_recorded: monitorStats.events_recorded,
      dropped_keys: monitorStats.dropped_keys,
      minute_archive_capture_failures: monitorStats.minute_archive_capture_failures,
      processing_ms: Number(
        monitorStats.processing_ns / 1_000_000n
      ),
      started_at: monitorStats.started_at,
      live_history_size: liveHistory.length,
      minute_history_size: minuteHistory.length,
    },
    live: summarize(liveWindow),
    minute: summarize(minuteWindow),
    recent_live: cloneHistory(liveHistory),
    recent_minutes: cloneHistory(minuteHistory),
  }
}

const rotateTimer = setInterval(
  rotateWindows,
  5 * 1000
)

rotateTimer.unref?.()

registerRuntimeInspectable({
  name: 'System Usage Monitor',
  mode: 'always_awake',
  reader: () => {
    const liveHistoryEntries = liveHistory.reduce(
      (sum, item) => sum + (Array.isArray(item?.rows) ? item.rows.length : 0),
      0
    )
    const minuteHistoryEntries = minuteHistory.reduce(
      (sum, item) => sum + (Array.isArray(item?.rows) ? item.rows.length : 0),
      0
    )
    const entries =
      liveWindow.rows.size +
      minuteWindow.rows.size +
      liveHistoryEntries +
      minuteHistoryEntries

    return {
      state: 'active',
      entries,
      live_keys: liveWindow.rows.size,
      minute_keys: minuteWindow.rows.size,
      live_history_windows: liveHistory.length,
      minute_history_windows: minuteHistory.length,
      live_history_entries: liveHistoryEntries,
      minute_history_entries: minuteHistoryEntries,
      max_live_windows: MAX_LIVE_WINDOWS,
      max_minute_windows: MAX_MINUTE_WINDOWS,
      max_keys_per_window: MAX_KEYS_PER_WINDOW,
      events_recorded: monitorStats.events_recorded,
      dropped_keys: monitorStats.dropped_keys,
      minute_archive_capture_failures: monitorStats.minute_archive_capture_failures,
      minute_archive_compressed_bytes: minuteHistory.reduce(
        (sum, item) => sum + (item.minute_archive?.length || 0), 0
      ),
      timer_seconds: 5,
    }
  },
})
