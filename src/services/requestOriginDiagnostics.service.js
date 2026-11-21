import { createHash } from 'node:crypto'

const WINDOW_MS = 60_000
const MAX_WINDOWS = 120
const MAX_GROUPS_PER_WINDOW = 80
const MAX_REPORT_IDS = 2500
const MAX_EVENTS_PER_REPORT = 6
const MAX_REPORT_AGE_MS = 10 * 60_000
const ALLOWED_PAGES = new Set(['DISCOVER', 'READER'])
const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])
const ALLOWED_TRIGGERS = new Set([
  'mount', 'timer', 'focus', 'visibility', 'retry', 'navigation',
  'reload', 'user_action', 'background', 'unknown',
])
const SAFE_SEGMENTS = new Set([
  'api', 'public', 'stories', 'story', 'episodes', 'episode', 'view', 'recommendations',
  'read', 'authors', 'discover', 'posts', 'feed', 'books', 'reader', 'reader-presence',
  'heartbeat', 'reading-progress', 'tasks', 'reading-session', 'progress',
  'comments', 'latest', 'reactions', 'advertisements', 'smart-ads', 'select',
  'content-versions', 'shadow-mall', 'promotions', 'ad-control', 'unlocks',
  'purchase', 'premium', 'status', 'notifications', 'unread-count', 'check-in',
  'offline-control', 'users', 'profile', 'me', 'settings', 'follow', 'following',
  'reader-posts', 'social-statuses', 'boost-engagement', 'genres', 'slides',
  'banners', 'home', 'fast', 'reels', 'search', 'bookmarks', 'saves', 'saved',
  'like', 'likes', 'events', 'health', 'maintenance', 'other',
])

const windows = new Map()
const seenReports = new Map()
let droppedGroups = 0
let rejectedReports = 0
let replayReports = 0

function safeInteger(value, min, max) {
  return Number.isInteger(value) && value >= min && value <= max ? value : null
}

function safeRoute(value) {
  if (typeof value !== 'string' || value.length > 180) return null
  const parts = value.toLowerCase().split('/').filter(Boolean)
  if (parts[0] !== 'api' || parts.length > 8 || parts.length < 2) return null
  return '/' + parts.map((part) => SAFE_SEGMENTS.has(part) ? part : ':id').join('/')
}

function safeSource(value) {
  if (value === 'UNATTRIBUTED') return value
  if (typeof value !== 'string' || value.length > 140 || value.includes('..')) return null
  return /^src\/(?:pages|hooks|components|services|providers|utils)\/[a-zA-Z\d_./-]+\.[cm]?[jt]sx?$/.test(value) ? value : null
}

function safeBuild(value) {
  if (typeof value !== 'string' || value.length > 32) return null
  return /^[a-zA-Z\d_.-]+$/.test(value) ? value : null
}

function parseEvent(value, now) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  if (!ALLOWED_PAGES.has(value.page) || !ALLOWED_METHODS.has(value.method) || !ALLOWED_TRIGGERS.has(value.trigger)) return null
  const route = safeRoute(value.route)
  const source = safeSource(value.source_file)
  const count = safeInteger(value.observed_count, 4, 120)
  const windowMs = [10_000, 60_000].includes(value.window_ms) ? value.window_ms : null
  const hidden = safeInteger(value.hidden_count, 0, 120)
  const errors = safeInteger(value.error_count, 0, 120)
  const observed = Date.parse(value.observed_at)
  if (!route || !source || count === null || !windowMs || hidden === null || errors === null || hidden > count || errors > count ||
      !Number.isFinite(observed) || Math.abs(now - observed) > MAX_REPORT_AGE_MS) return null
  if (windowMs === 10_000 && count < 4) return null
  if (windowMs === 60_000 && count < 12) return null
  return {
    page: value.page,
    route,
    method: value.method,
    source_file: source,
    trigger: value.trigger,
    observed_count: count,
    window_ms: windowMs,
    hidden_count: hidden,
    error_count: errors,
  }
}

function prune(now) {
  const oldestWindow = Math.floor(now / WINDOW_MS) * WINDOW_MS - (MAX_WINDOWS - 1) * WINDOW_MS
  for (const key of windows.keys()) {
    if (key < oldestWindow || key > now) windows.delete(key)
  }
  for (const [key, savedAt] of seenReports) {
    if (now - savedAt > MAX_REPORT_AGE_MS) seenReports.delete(key)
  }
  while (seenReports.size > MAX_REPORT_IDS) seenReports.delete(seenReports.keys().next().value)
}

export function recordRequestOriginReport(payload, now = Date.now()) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.version !== 1 || payload.sampled !== true ||
      payload.sample_rate !== 0.1 || typeof payload.report_id !== 'string' ||
      !/^[a-f\d-]{36}$/i.test(payload.report_id) || typeof payload.session_id !== 'string' ||
      !/^[a-f\d-]{36}$/i.test(payload.session_id) || !Array.isArray(payload.events) ||
      payload.events.length < 1 || payload.events.length > MAX_EVENTS_PER_REPORT) {
    rejectedReports += 1
    return false
  }
  const build = safeBuild(payload.build)
  const events = payload.events.map((event) => parseEvent(event, now))
  if (!build || events.some((event) => !event)) {
    rejectedReports += 1
    return false
  }
  prune(now)
  const reportKey = createHash('sha256').update(payload.report_id).digest('hex')
  if (seenReports.has(reportKey)) {
    replayReports += 1
    return true
  }
  seenReports.set(reportKey, now)
  const windowKey = Math.floor(now / WINDOW_MS) * WINDOW_MS
  if (!windows.has(windowKey)) windows.set(windowKey, new Map())
  const window = windows.get(windowKey)
  for (const event of events) {
    const key = [event.page, event.method, event.route, event.source_file, event.trigger, build].join('\u001f')
    if (!window.has(key) && window.size >= MAX_GROUPS_PER_WINDOW) {
      droppedGroups += 1
      continue
    }
    const entry = window.get(key) || {
      page: event.page,
      method: event.method,
      route: event.route,
      source_file: event.source_file,
      trigger: event.trigger,
      build,
      reports: 0,
      observed_fetch_invocations_in_reported_windows: 0,
      client_reported_hidden: 0,
      client_reported_errors: 0,
      shortest_window_ms: 60_000,
      last_seen_at: null,
    }
    entry.reports += 1
    entry.observed_fetch_invocations_in_reported_windows += event.observed_count
    entry.client_reported_hidden += event.hidden_count
    entry.client_reported_errors += event.error_count
    entry.shortest_window_ms = Math.min(entry.shortest_window_ms, event.window_ms)
    entry.last_seen_at = new Date(now).toISOString()
    window.set(key, entry)
  }
  return true
}

export function getRequestOriginSnapshot(options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now()
  prune(now)
  const minutes = Math.min(MAX_WINDOWS, Math.max(1, Math.floor(Number(options.minutes) || 60)))
  const limit = Math.min(60, Math.max(1, Math.floor(Number(options.limit) || 40)))
  const from = Math.floor(now / WINDOW_MS) * WINDOW_MS - (minutes - 1) * WINDOW_MS
  const combined = new Map()
  let windowsObserved = 0
  for (const [windowKey, window] of windows) {
    if (windowKey < from || windowKey > now) continue
    windowsObserved += 1
    for (const [key, row] of window) {
      const current = combined.get(key) || {
        ...row,
        reports: 0,
        observed_fetch_invocations_in_reported_windows: 0,
        client_reported_hidden: 0,
        client_reported_errors: 0,
        shortest_window_ms: 60_000,
        last_seen_at: null,
      }
      current.reports += row.reports
      current.observed_fetch_invocations_in_reported_windows += row.observed_fetch_invocations_in_reported_windows
      current.client_reported_hidden += row.client_reported_hidden
      current.client_reported_errors += row.client_reported_errors
      current.shortest_window_ms = Math.min(current.shortest_window_ms, row.shortest_window_ms)
      if (!current.last_seen_at || current.last_seen_at < row.last_seen_at) current.last_seen_at = row.last_seen_at
      combined.set(key, current)
    }
  }
  const rows = [...combined.values()].sort((a, b) =>
    b.reports - a.reports || b.observed_fetch_invocations_in_reported_windows - a.observed_fetch_invocations_in_reported_windows)
  return {
    mode: 'sampled_client_anomaly_aggregates',
    verdict: 'suspected_only_requires_correlation_with_server_metrics',
    persistence: 'bounded_process_memory',
    sampling_rate: 0.1,
    window_minutes: minutes,
    windows_observed: windowsObserved,
    group_count: rows.length,
    detail_capped: rows.length > limit,
    measurement_note: 'Reports originate from sampled browsers. Counts represent overlapping fetch invocations that may include cache hits, not unique backend HTTP totals. Source and trigger are client-declared.',
    coverage: {
      source_unattributed: rows.filter((row) => row.source_file === 'UNATTRIBUTED').reduce((sum, row) => sum + row.reports, 0),
      dropped_group_observations: droppedGroups,
      rejected_reports: rejectedReports,
      replay_reports: replayReports,
      browser_fetch_only: true,
    },
    rows: rows.slice(0, limit),
  }
}
