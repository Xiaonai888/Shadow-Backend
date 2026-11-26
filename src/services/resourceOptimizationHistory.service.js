import { buildResourceOptimizationAdvisor } from './resourceOptimizationAdvisor.service.js'
import { optimizationPage } from './resourceOptimizationIdentity.service.js'

const WINDOW_MS = 15 * 60_000
const MAX_GROUPS = 2000
const METRICS = ['observations', 'repeated_signatures', 'cross_page_repeats', 'observed_response_bytes', 'repeat_response_bytes', 'supabase_calls', 'repeat_supabase_calls', 'cache_hits', 'cache_misses', 'cache_bypasses', 'cache_stale', 'cache_coalesced', 'cache_unknown']
const HTTP_ROUTES = new Set(['GET /api/public/stories', 'GET /api/public/stories/:id/episodes', 'GET /api/public/stories/:id/recommendations', 'GET /api/public/stories/:id', 'GET /api/reading-progress'])

function count(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0
}

function emptyMetrics() {
  return Object.fromEntries(METRICS.map(key => [key, 0]))
}

function addMetrics(target, source) {
  for (const key of METRICS) target[key] = Math.min(Number.MAX_SAFE_INTEGER, target[key] + count(source?.[key]))
}

function validRoute(row) {
  if (row?.kind === 'HTTP') return HTTP_ROUTES.has(row.route)
  return row?.kind === 'SUPABASE' && /^GET \/rest\/v1\/[a-z][a-z0-9_]{0,79}$/.test(String(row.route || ''))
}

export function buildResourceOptimizationHistory(stored, fromMs, toMs, { limit = 80 } = {}) {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs >= toMs) throw new RangeError('Invalid optimization history range.')
  const totals = emptyMetrics()
  const grouped = new Map()
  const seen = new Set()
  let detailCapped = false
  let duplicateWindows = 0
  let missingEvidenceWindows = 0
  let rejectedRows = 0
  const expected = Math.max(0, Math.floor(toMs / WINDOW_MS) - Math.ceil(fromMs / WINDOW_MS))
  for (const window of Array.isArray(stored) ? stored : []) {
    const start = Date.parse(window?.window_start)
    const end = Date.parse(window?.window_end)
    if (!Number.isFinite(start) || !Number.isFinite(end) || start % WINDOW_MS !== 0 || start < fromMs || end > toMs || end - start !== WINDOW_MS) continue
    const data = window?.payload?.resource_optimization
    if (data?.version !== 1 || data.window_ms !== WINDOW_MS || Date.parse(data.from) !== start || Date.parse(data.to) !== end || !Array.isArray(data.rows) || !data.totals || data.windows_observed !== 1) {
      missingEvidenceWindows++
      continue
    }
    if (seen.has(start)) { duplicateWindows++; continue }
    seen.add(start)
    addMetrics(totals, data.totals)
    if (data.detail_capped || count(data.total_rows) > data.rows.length) detailCapped = true
    for (const row of data.rows) {
      if (!validRoute(row)) { rejectedRows++; continue }
      const page = optimizationPage(row.page)
      const key = `${row.kind}\u001f${row.route}\u001f${page}`
      let item = grouped.get(key)
      if (!item) {
        if (grouped.size >= MAX_GROUPS) { detailCapped = true; continue }
        item = { kind: row.kind, route: row.route, page, ...emptyMetrics() }
        grouped.set(key, item)
      }
      addMetrics(item, row)
    }
  }
  const ranked = [...grouped.values()].sort((a, b) => b.repeat_response_bytes - a.repeat_response_bytes || b.repeated_signatures - a.repeated_signatures || b.observations - a.observations)
  const cap = Math.min(120, Math.max(1, count(limit) || 80))
  const evidence = {
    version: 1,
    mode: 'passive_review_only',
    persistence: 'stored_15_minute_snapshot',
    from: new Date(fromMs).toISOString(),
    to: new Date(toMs).toISOString(),
    status: seen.size === 0 ? 'unavailable' : seen.size < expected ? 'partial' : 'observed',
    window_ms: WINDOW_MS,
    stored_windows: seen.size,
    expected_complete_windows: expected,
    totals: seen.size ? totals : null,
    total_rows: ranked.length,
    detail_capped: detailCapped || rejectedRows > 0 || ranked.length > cap,
    coverage: { duplicate_windows_ignored: duplicateWindows, stored_rows_without_valid_evidence: missingEvidenceWindows, rejected_detail_rows: rejectedRows, missing_complete_windows: Math.max(0, expected - seen.size), partial_boundary_windows_excluded: fromMs % WINDOW_MS !== 0 || toMs % WINDOW_MS !== 0, live_and_archived_rollups_excluded: true, process_counter_totals_not_summed: true, scope: 'selected HTTP GET routes and same-context successful Supabase REST GET' },
    rows: ranked.slice(0, cap),
  }
  return { evidence, advisor: buildResourceOptimizationAdvisor(evidence) }
}
