import { optimizationHttpIdentity, optimizationPage, optimizationSupabaseIdentity } from './resourceOptimizationIdentity.service.js'

const WINDOW_MS = 15 * 60_000
const REPEAT_MS = 30_000
const MAX_WINDOWS = 4
const MAX_ROWS = 240
const MAX_RECENT = 2500
const MAX_DB_KEYS = 32
const METRICS = ['observations', 'repeated_signatures', 'cross_page_repeats', 'observed_response_bytes', 'repeat_response_bytes', 'supabase_calls', 'repeat_supabase_calls', 'cache_hits', 'cache_misses', 'cache_bypasses', 'cache_stale', 'cache_coalesced', 'cache_unknown']

function number(value) {
  const n = Number(value)
  return Number.isFinite(n) ? Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.floor(n))) : 0
}

function emptyMetrics() {
  return Object.fromEntries(METRICS.map(key => [key, 0]))
}

function cacheState(value) {
  const state = String(value || '').toUpperCase()
  if (['HIT', 'NAVIGATION_HIT'].includes(state)) return 'cache_hits'
  if (state === 'MISS') return 'cache_misses'
  if (state === 'BYPASS') return 'cache_bypasses'
  if (state === 'STALE') return 'cache_stale'
  if (state === 'COALESCED') return 'cache_coalesced'
  return 'cache_unknown'
}

export function createResourceOptimizationEvidence() {
  const windows = new Map()
  const recent = new Map()
  const dbContexts = new WeakMap()
  const coverage = { dropped_rows: 0, dropped_recent: 0, dropped_db_keys: 0, skipped_http_identity: 0 }

  function rowFor(kind, route, page, now) {
    const stamp = Math.floor(now / WINDOW_MS) * WINDOW_MS
    for (const key of windows.keys()) if (key < stamp - (MAX_WINDOWS - 1) * WINDOW_MS) windows.delete(key)
    let window = windows.get(stamp)
    if (!window) {
      if (windows.size >= MAX_WINDOWS) windows.delete(Math.min(...windows.keys()))
      window = new Map()
      windows.set(stamp, window)
    }
    const key = `${kind}\u001f${route}\u001f${page}`
    let row = window.get(key)
    if (!row) {
      if (window.size >= MAX_ROWS) { coverage.dropped_rows++; return null }
      row = { kind, route, page, ...emptyMetrics() }
      window.set(key, row)
    }
    return row
  }

  function observeHttp(req, res, context, options = {}) {
    if (options.closeReason !== 'finish' || Number(res?.statusCode) !== 200 || !context) return
    if (String(req?.method || '').toUpperCase() !== 'GET') return
    const identity = optimizationHttpIdentity(req)
    if (!identity) { coverage.skipped_http_identity++; return }
    const now = Number.isFinite(options.now) ? options.now : Date.now()
    const page = optimizationPage(context.page)
    const row = rowFor('HTTP', identity.route, page, now)
    if (!row) return
    const bytes = number(options.responseBytes)
    const calls = number(context.supabase_calls)
    const previous = recent.get(identity.key)
    const repeated = previous && now >= previous.at && now - previous.at <= REPEAT_MS
    const crossPage = repeated && previous.page !== page && ![previous.page, page].some(p => p === 'UNATTRIBUTED' || p.endsWith('/:other'))
    row.observations++
    row.observed_response_bytes += bytes
    row.supabase_calls += calls
    row[cacheState(options.cacheState)]++
    if (repeated) {
      row.repeated_signatures++
      row.repeat_response_bytes += bytes
      row.repeat_supabase_calls += calls
      if (crossPage) row.cross_page_repeats++
    }
    if (previous) recent.delete(identity.key)
    while (recent.size) {
      const [oldKey, old] = recent.entries().next().value
      if (now >= old.at && now - old.at <= REPEAT_MS && recent.size < MAX_RECENT) break
      if (now - old.at <= REPEAT_MS) coverage.dropped_recent++
      recent.delete(oldKey)
    }
    recent.set(identity.key, { at: now, page })
  }

  function observeSupabaseRead(options = {}) {
    if (options.status !== 200 && options.status !== 206) return
    const identity = optimizationSupabaseIdentity(options)
    if (!identity || typeof options.context !== 'object') return
    let seen = dbContexts.get(options.context)
    if (!seen) { seen = new Set(); dbContexts.set(options.context, seen) }
    const repeated = seen.has(identity.key)
    if (!repeated && seen.size >= MAX_DB_KEYS) { coverage.dropped_db_keys++; return }
    seen.add(identity.key)
    const now = Number.isFinite(options.now) ? options.now : Date.now()
    const row = rowFor('SUPABASE', identity.route, optimizationPage(options.context.page), now)
    if (!row) return
    row.observations++
    if (repeated) row.repeated_signatures++
  }

  function snapshot({ now = Date.now(), from = Math.floor(now / WINDOW_MS) * WINDOW_MS - 3 * WINDOW_MS, to = now + 1, limit = 80 } = {}) {
    const grouped = new Map()
    const totals = emptyMetrics()
    let windowsObserved = 0
    const earliest = Math.floor(now / WINDOW_MS) * WINDOW_MS - (MAX_WINDOWS - 1) * WINDOW_MS
    for (const [stamp, window] of windows) {
      if (stamp < earliest || stamp + WINDOW_MS <= from || stamp >= to) continue
      windowsObserved++
      for (const [key, row] of window) {
        let current = grouped.get(key)
        if (!current) { current = { kind: row.kind, route: row.route, page: row.page, ...emptyMetrics() }; grouped.set(key, current) }
        for (const metric of METRICS) { current[metric] += row[metric]; totals[metric] += row[metric] }
      }
    }
    const rows = [...grouped.values()].sort((a, b) => b.repeat_response_bytes - a.repeat_response_bytes || b.repeated_signatures - a.repeated_signatures || b.observations - a.observations)
    const cap = Math.min(120, Math.max(1, number(limit) || 80))
    return { version: 1, mode: 'passive_review_only', window_ms: WINDOW_MS, repeat_ms: REPEAT_MS, from: new Date(from).toISOString(), to: new Date(to).toISOString(), windows_observed: windowsObserved, bucket_boundary_note: 'Overlapping buckets included in full', coverage: { ...coverage, max_windows: MAX_WINDOWS, max_rows_per_window: MAX_ROWS, max_recent_keys: MAX_RECENT, http_scope: 'selected_get_routes_with_bearer_or_visitor_header', database_scope: 'successful_rest_get_within_same_request_context', counters_since_process_start: true }, totals, total_rows: rows.length, detail_capped: rows.length > cap, rows: rows.slice(0, cap) }
  }

  return { observeHttp, observeSupabaseRead, snapshot }
}

const evidence = createResourceOptimizationEvidence()
export const observeResourceOptimizationHttp = evidence.observeHttp
export const observeResourceOptimizationSupabaseRead = evidence.observeSupabaseRead
export const getResourceOptimizationEvidenceSnapshot = evidence.snapshot
