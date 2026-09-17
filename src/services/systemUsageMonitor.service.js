const LIVE_WINDOW_MS = 15 * 1000
const MINUTE_WINDOW_MS = 60 * 1000
const MAX_LIVE_WINDOWS = 16
const MAX_MINUTE_WINDOWS = 120
const MAX_KEYS_PER_WINDOW = 500
const MAX_ROWS_PER_SNAPSHOT = 100

let liveWindow = createWindow(LIVE_WINDOW_MS)
let minuteWindow = createWindow(MINUTE_WINDOW_MS)

const liveHistory = []
const minuteHistory = []

const monitorStats = {
  events_recorded: 0,
  dropped_keys: 0,
  processing_ns: 0n,
  started_at: Date.now(),
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
    monitorStats.dropped_keys += 1
  }

  const current = window.rows.get(key) || {
    kind: safeSample.kind,
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
  return [...window.rows.values()]
    .map((row) => ({
      kind: row.kind,
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
    .sort((a, b) => b.bytes - a.bytes || b.count - a.count)
    .slice(0, MAX_ROWS_PER_SNAPSHOT)
}

function summarize(window) {
  let count = 0
  let bytes = 0
  let errors = 0

  for (const row of window.rows.values()) {
    count += row.count
    bytes += row.bytes
    errors += row.errors
  }

  return {
    started_at: window.started_at,
    ended_at: window.ended_at,
    interval_seconds: window.interval_ms / 1000,
    count,
    bytes,
    mb: Number((bytes / 1024 / 1024).toFixed(4)),
    errors,
    rows: snapshotRows(window),
  }
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
        summarize(minuteWindow),
        MAX_MINUTE_WINDOWS
      )
    }

    minuteWindow = createWindow(MINUTE_WINDOW_MS, now)
  }
}

function cloneHistory(items) {
  return items.map((item) => ({
    ...item,
    rows: item.rows.map((row) => ({ ...row })),
  }))
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
