import { supabase } from '../config/supabase.js'
import { getSystemUsageSnapshot } from './systemUsageMonitor.service.js'

const SNAPSHOT_MS = 15 * 60 * 1000
const PROVIDER_SYNC_MS = 60 * 60 * 1000
const PROVIDER_WINDOW_MS = 60 * 60 * 1000
const PROVIDER_TIMEOUT_MS = 10 * 1000
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000
const CLEANUP_MS = 24 * 60 * 60 * 1000
const MAX_DETAIL_ROWS = 100

let startTimer = null
let intervalTimer = null
let writing = false
let providerSyncing = false
let lastCleanupAt = 0

const providerState = {
  last_sync_at: null,
  next_sync_at: null,
  render: {
    status: 'not_configured',
    checked_at: null,
  },
  supabase: {
    status: 'not_configured',
    checked_at: null,
  },
  reconciliation: null,
  poll_requests: 0,
  poll_errors: 0,
}

function alignedWindowEnd(now = Date.now()) {
  return Math.floor(now / SNAPSHOT_MS) * SNAPSHOT_MS
}

function safeNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(0, number) : 0
}

function toMb(bytes) {
  return Number((safeNumber(bytes) / 1024 / 1024).toFixed(4))
}

function cloneProviderState() {
  return JSON.parse(JSON.stringify(providerState))
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

      const count = safeNumber(row.count)

      current.count += count
      current.bytes += safeNumber(row.bytes)
      current.errors += safeNumber(row.errors)
      current.weighted_ms += safeNumber(row.avg_ms) * count

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
      mb: toMb(row.bytes),
      errors: row.errors,
      avg_ms: row.count
        ? Number((row.weighted_ms / row.count).toFixed(1))
        : 0,
    }))
    .sort((a, b) => b.bytes - a.bytes || b.count - a.count)
    .slice(0, MAX_DETAIL_ROWS)
}

function summarizeMinutes(minutes = []) {
  return minutes.reduce(
    (result, minute) => {
      result.count += safeNumber(minute.count)
      result.bytes += safeNumber(minute.bytes)
      result.errors += safeNumber(minute.errors)
      return result
    },
    { count: 0, bytes: 0, errors: 0 }
  )
}

function summarizeDependency(minutes = [], dependency) {
  const expected = String(dependency || '').toUpperCase()

  return minutes.reduce(
    (result, minute) => {
      for (const row of minute.rows || []) {
        if (
          String(row.dependency || '').toUpperCase() !== expected
        ) {
          continue
        }

        result.count += safeNumber(row.count)
        result.bytes += safeNumber(row.bytes)
        result.errors += safeNumber(row.errors)
      }

      return result
    },
    { count: 0, bytes: 0, errors: 0 }
  )
}

function recentProviderMinutes(source, now = Date.now()) {
  const cutoff = now - PROVIDER_WINDOW_MS

  return (source.recent_minutes || []).filter(
    (minute) =>
      safeNumber(minute.started_at) >= cutoff &&
      safeNumber(minute.started_at) < now
  )
}

function buildSnapshot(now = Date.now()) {
  const source = getSystemUsageSnapshot()
  const windowEnd = alignedWindowEnd(now)
  const windowStart = windowEnd - SNAPSHOT_MS

  const minutes = (source.recent_minutes || []).filter(
    (minute) =>
      safeNumber(minute.started_at) >= windowStart &&
      safeNumber(minute.started_at) < windowEnd
  )

  const totals = summarizeMinutes(minutes)

  return {
    source,
    windowStart,
    windowEnd,
    totals,
    payload: {
      version: 2,
      interval_minutes: 15,
      available_minutes: minutes.length,
      detail_limit: MAX_DETAIL_ROWS,
      monitor: source.monitor,
      top_rows: aggregateRows(minutes),
      provider_reconciliation: cloneProviderState(),
    },
  }
}

function projectRefFromUrl() {
  const explicit = String(
    process.env.SUPABASE_PROJECT_REF || ''
  ).trim()

  if (explicit) return explicit

  try {
    const url = new URL(String(process.env.SUPABASE_URL || ''))
    const host = url.hostname.toLowerCase()

    if (!host.endsWith('.supabase.co')) return ''

    return host.slice(0, -'.supabase.co'.length)
  } catch {
    return ''
  }
}

async function fetchJson(url, token) {
  const controller = new AbortController()
  const timeout = setTimeout(
    () => controller.abort(),
    PROVIDER_TIMEOUT_MS
  )

  timeout.unref?.()

  try {
    providerState.poll_requests += 1

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
      },
    })

    const data = await response.json().catch(() => null)

    if (!response.ok) {
      const error = new Error(
        `Provider request failed with HTTP ${response.status}.`
      )
      error.statusCode = response.status
      throw error
    }

    return data
  } catch (error) {
    providerState.poll_errors += 1
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

function bytesMultiplier(unit) {
  const normalized = String(unit || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')

  if (
    normalized === 'b' ||
    normalized === 'byte' ||
    normalized === 'bytes'
  ) {
    return 1
  }

  if (normalized === 'kb') return 1000
  if (normalized === 'kib') return 1024
  if (normalized === 'mb') return 1000 ** 2
  if (normalized === 'mib') return 1024 ** 2
  if (normalized === 'gb') return 1000 ** 3
  if (normalized === 'gib') return 1024 ** 3
  if (normalized === 'tb') return 1000 ** 4
  if (normalized === 'tib') return 1024 ** 4

  return null
}

function parseRenderBandwidth(data) {
  if (!Array.isArray(data)) {
    return {
      comparable: false,
      series_count: 0,
      provider_bytes: null,
      units: [],
    }
  }

  let totalBytes = 0
  let comparableSeries = 0
  const units = new Set()

  for (const series of data) {
    const unit = String(series?.unit || '').trim()
    const multiplier = bytesMultiplier(unit)

    if (unit) units.add(unit)
    if (!multiplier || !Array.isArray(series?.values)) continue

    const nativeTotal = series.values.reduce(
      (sum, point) => sum + safeNumber(point?.value),
      0
    )

    totalBytes += nativeTotal * multiplier
    comparableSeries += 1
  }

  return {
    comparable: comparableSeries > 0,
    series_count: data.length,
    comparable_series: comparableSeries,
    provider_bytes:
      comparableSeries > 0 ? Math.round(totalBytes) : null,
    units: [...units].slice(0, 10),
  }
}

function parseSupabaseUsageCounts(data) {
  const rows = Array.isArray(data?.result)
    ? data.result
    : []

  const latest = rows.at(-1) || null

  if (!latest) {
    return {
      available: false,
      rows: 0,
      timestamp: null,
      total_requests: null,
      breakdown: null,
    }
  }

  const breakdown = {
    auth: safeNumber(latest.total_auth_requests),
    realtime: safeNumber(latest.total_realtime_requests),
    rest: safeNumber(latest.total_rest_requests),
    storage: safeNumber(latest.total_storage_requests),
  }

  return {
    available: true,
    rows: rows.length,
    timestamp: latest.timestamp || null,
    total_requests:
      breakdown.auth +
      breakdown.realtime +
      breakdown.rest +
      breakdown.storage,
    breakdown,
  }
}

async function syncRenderProvider(now) {
  const apiKey = String(
    process.env.RENDER_API_KEY ||
    process.env.SYSTEM_RENDER_API_KEY ||
    ''
  ).trim()
  const serviceId = String(
    process.env.RENDER_SERVICE_ID ||
    process.env.SYSTEM_RENDER_SERVICE_ID ||
    ''
  ).trim()

  if (!apiKey || !serviceId) {
    providerState.render = {
      status: 'not_configured',
      checked_at: new Date(now).toISOString(),
      missing: [
        !apiKey ? 'RENDER_API_KEY' : null,
        !serviceId ? 'RENDER_SERVICE_ID' : null,
      ].filter(Boolean),
    }
    return
  }

  const start = new Date(now - PROVIDER_WINDOW_MS).toISOString()
  const end = new Date(now).toISOString()
  const query = new URLSearchParams({
    startTime: start,
    endTime: end,
    resource: serviceId,
  })

  try {
    const data = await fetchJson(
      `https://api.render.com/v1/metrics/bandwidth?${query}`,
      apiKey
    )
    const parsed = parseRenderBandwidth(data)

    providerState.render = {
      status: parsed.comparable ? 'ok' : 'unsupported_unit',
      checked_at: new Date(now).toISOString(),
      window_start: start,
      window_end: end,
      service_id: serviceId,
      ...parsed,
    }
  } catch (error) {
    providerState.render = {
      status: 'error',
      checked_at: new Date(now).toISOString(),
      window_start: start,
      window_end: end,
      service_id: serviceId,
      error:
        String(error?.message || 'Render provider sync failed.')
          .slice(0, 300),
    }
  }
}

async function syncSupabaseProvider(now) {
  const token = String(
    process.env.SUPABASE_MANAGEMENT_TOKEN ||
    process.env.SYSTEM_SUPABASE_MANAGEMENT_TOKEN ||
    ''
  ).trim()
  const projectRef = projectRefFromUrl()

  if (!token || !projectRef) {
    providerState.supabase = {
      status: 'not_configured',
      checked_at: new Date(now).toISOString(),
      missing: [
        !token ? 'SUPABASE_MANAGEMENT_TOKEN' : null,
        !projectRef ? 'SUPABASE_PROJECT_REF' : null,
      ].filter(Boolean),
    }
    return
  }

  try {
    const data = await fetchJson(
      `https://api.supabase.com/v1/projects/${encodeURIComponent(projectRef)}/analytics/endpoints/usage.api-counts`,
      token
    )
    const parsed = parseSupabaseUsageCounts(data)

    providerState.supabase = {
      status: parsed.available ? 'ok' : 'empty',
      checked_at: new Date(now).toISOString(),
      project_ref: projectRef,
      provider_period: 'provider_default',
      ...parsed,
    }
  } catch (error) {
    providerState.supabase = {
      status: 'error',
      checked_at: new Date(now).toISOString(),
      project_ref: projectRef,
      error:
        String(error?.message || 'Supabase provider sync failed.')
          .slice(0, 300),
    }
  }
}

function updateReconciliation(source, now) {
  const minutes = recentProviderMinutes(source, now)
  const app = summarizeMinutes(minutes)
  const appSupabase = summarizeDependency(minutes, 'SUPABASE')
  const renderProviderBytes =
    Number.isFinite(providerState.render?.provider_bytes)
      ? providerState.render.provider_bytes
      : null

  providerState.reconciliation = {
    window_minutes: 60,
    available_app_minutes: minutes.length,
    app_attributed: {
      requests: app.count,
      bytes: app.bytes,
      mb: toMb(app.bytes),
      errors: app.errors,
    },
    render: {
      comparable: renderProviderBytes !== null,
      provider_bytes: renderProviderBytes,
      provider_mb:
        renderProviderBytes !== null
          ? toMb(renderProviderBytes)
          : null,
      unattributed_bytes_estimate:
        renderProviderBytes !== null
          ? Math.max(0, renderProviderBytes - app.bytes)
          : null,
      unattributed_mb_estimate:
        renderProviderBytes !== null
          ? toMb(Math.max(0, renderProviderBytes - app.bytes))
          : null,
    },
    supabase: {
      app_attributed_calls: appSupabase.count,
      app_attributed_bytes: appSupabase.bytes,
      provider_request_count:
        providerState.supabase?.total_requests ?? null,
      comparable_period: false,
    },
  }
}

async function syncProvidersIfDue(source, now = Date.now()) {
  if (providerSyncing) return

  const lastSync = providerState.last_sync_at
    ? new Date(providerState.last_sync_at).getTime()
    : 0

  if (
    Number.isFinite(lastSync) &&
    lastSync > 0 &&
    now - lastSync < PROVIDER_SYNC_MS
  ) {
    return
  }

  providerSyncing = true

  try {
    await Promise.all([
      syncRenderProvider(now),
      syncSupabaseProvider(now),
    ])

    providerState.last_sync_at = new Date(now).toISOString()
    providerState.next_sync_at = new Date(
      now + PROVIDER_SYNC_MS
    ).toISOString()

    updateReconciliation(source, now)
  } finally {
    providerSyncing = false
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
    const now = Date.now()
    const initial = buildSnapshot(now)

    await syncProvidersIfDue(initial.source, now)

    const snapshot = buildSnapshot(now)

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

    await cleanupOldSnapshots(now)
  } catch (error) {
    console.error(
      'SYSTEM_USAGE_SNAPSHOT_ERROR:',
      error?.message || error
    )
  } finally {
    writing = false
  }
}

const HISTORY_MAX_RANGE_MS = 31 * 24 * 60 * 60 * 1000
const HISTORY_PAGE_SIZE = 1000

function historyRowKey(row) {
  return [
    row.kind || 'unknown',
    row.feature || 'unknown',
    row.source_route || 'UNKNOWN',
    row.dependency || 'UNKNOWN',
  ].join('\u001f')
}

function mergeHistoryRows(target, rows = []) {
  for (const row of rows) {
    const key = historyRowKey(row)
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

async function loadStoredHistory(fromIso, toIso) {
  const rows = []

  for (let offset = 0; ; offset += HISTORY_PAGE_SIZE) {
    const { data, error } = await supabase
      .from('system_usage_snapshots')
      .select(
        'window_start,window_end,request_count,bytes,errors,payload'
      )
      .gt('window_end', fromIso)
      .lt('window_start', toIso)
      .order('window_start', { ascending: true })
      .range(offset, offset + HISTORY_PAGE_SIZE - 1)

    if (error) throw error

    const page = Array.isArray(data) ? data : []
    rows.push(...page)

    if (page.length < HISTORY_PAGE_SIZE) break
    if (rows.length >= 4000) break
  }

  return rows
}

export async function getSystemUsageHistory({
  from,
  to,
} = {}) {
  const fromMs = new Date(from || '').getTime()
  const requestedToMs = new Date(to || '').getTime()

  if (
    !Number.isFinite(fromMs) ||
    !Number.isFinite(requestedToMs)
  ) {
    throw new Error('Valid from and to date-times are required.')
  }

  if (requestedToMs <= fromMs) {
    throw new Error('History end time must be after start time.')
  }

  if (requestedToMs - fromMs > HISTORY_MAX_RANGE_MS) {
    throw new Error('History range cannot exceed 31 days.')
  }

  const now = Date.now()
  const toMs = Math.min(requestedToMs, now)
  const fromIso = new Date(fromMs).toISOString()
  const toIso = new Date(toMs).toISOString()

  const stored = await loadStoredHistory(fromIso, toIso)
  const source = getSystemUsageSnapshot()

  const lastStoredEnd = stored.length
    ? new Date(stored.at(-1).window_end).getTime()
    : fromMs

  const liveStart = Math.max(fromMs, lastStoredEnd)

  const liveMinutes = (source.recent_minutes || []).filter(
    (minute) =>
      safeNumber(minute.started_at) >= liveStart &&
      safeNumber(minute.started_at) < toMs
  )

  const totals = {
    count: 0,
    bytes: 0,
    errors: 0,
  }

  const rowMap = new Map()
  const series = []

  for (const snapshot of stored) {
    totals.count += safeNumber(snapshot.request_count)
    totals.bytes += safeNumber(snapshot.bytes)
    totals.errors += safeNumber(snapshot.errors)

    mergeHistoryRows(
      rowMap,
      snapshot?.payload?.top_rows || []
    )

    series.push({
      started_at: snapshot.window_start,
      ended_at: snapshot.window_end,
      count: safeNumber(snapshot.request_count),
      bytes: safeNumber(snapshot.bytes),
      mb: toMb(snapshot.bytes),
      errors: safeNumber(snapshot.errors),
      source: 'stored',
    })
  }

  for (const minute of liveMinutes) {
    totals.count += safeNumber(minute.count)
    totals.bytes += safeNumber(minute.bytes)
    totals.errors += safeNumber(minute.errors)

    mergeHistoryRows(rowMap, minute.rows || [])

    series.push({
      started_at: new Date(
        safeNumber(minute.started_at)
      ).toISOString(),
      ended_at: new Date(
        safeNumber(minute.ended_at)
      ).toISOString(),
      count: safeNumber(minute.count),
      bytes: safeNumber(minute.bytes),
      mb: toMb(minute.bytes),
      errors: safeNumber(minute.errors),
      source: 'live',
    })
  }

  const rows = [...rowMap.values()]
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
            (row.weighted_ms / row.count).toFixed(1)
          )
        : 0,
    }))
    .sort(
      (a, b) =>
        b.bytes - a.bytes ||
        b.count - a.count
    )
    .slice(0, MAX_DETAIL_ROWS)

  series.sort(
    (a, b) =>
      new Date(a.started_at).getTime() -
      new Date(b.started_at).getTime()
  )

  const availableStart = series.length
    ? new Date(series[0].started_at).getTime()
    : null

  const availableEnd = series.length
    ? new Date(series.at(-1).ended_at).getTime()
    : null

  return {
    range: {
      requested_from: fromIso,
      requested_to: new Date(requestedToMs).toISOString(),
      effective_to: toIso,
      max_days: 31,
    },
    coverage: {
      stored_snapshots: stored.length,
      live_minutes: liveMinutes.length,
      available_from: availableStart
        ? new Date(availableStart).toISOString()
        : null,
      available_to: availableEnd
        ? new Date(availableEnd).toISOString()
        : null,
      partial:
        !availableStart ||
        availableStart > fromMs + SNAPSHOT_MS,
      stored_granularity_minutes: 15,
      live_granularity_minutes: 1,
    },
    totals: {
      requests: totals.count,
      bytes: totals.bytes,
      mb: toMb(totals.bytes),
      errors: totals.errors,
    },
    rows,
    series,
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
