import { compactResourceCostAttribution } from './resourceCostAttributionMinute.service.js'

function number(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0
}

function sourceOf(window) {
  if (window?.resource_cost_attribution?.version === 1) return window.resource_cost_attribution
  if (window?.payload?.resource_cost_attribution?.version === 1) return window.payload.resource_cost_attribution
  return null
}

function tracked(row) {
  return {
    feature: 'unattributed', kind: 'unclassified', dependency: 'UNKNOWN',
    route: 'NOT RECORDED', target: 'UNKNOWN', entry_point: 'unknown_entry',
    classification: 'not_recorded', count: row.count, bytes: row.bytes, errors: row.errors,
  }
}

export function buildResourceCostWindowAttribution(windows = [], options = {}) {
  const entries = []
  const expected = { count: 0, bytes: 0, errors: 0 }
  let modernWindows = 0
  let legacyWindows = 0
  for (const window of windows) {
    if (!window || typeof window !== 'object') continue
    const count = number(window.count ?? window.request_count ?? window.totals?.count)
    const bytes = number(window.bytes ?? window.totals?.bytes)
    const errors = number(window.errors ?? window.totals?.errors)
    expected.count += count
    expected.bytes += bytes
    expected.errors += errors
    const modern = sourceOf(window)
    if (modern) {
      modernWindows += 1
      entries.push(...modern.rows)
      continue
    }
    legacyWindows += 1
    if (Array.isArray(window.rows)) entries.push(...window.rows)
    else if (Array.isArray(window?.payload?.summary_rows)) entries.push(...window.payload.summary_rows.map((row) => ({
      ...row, route: 'FEATURE ONLY', target: 'MULTIPLE', classification: row.kind === 'unclassified' ? 'not_recorded' : 'feature_only',
    })))
    else if (Array.isArray(window?.payload?.top_rows)) entries.push(...window.payload.top_rows.map((row) => ({
      ...row, classification: 'legacy_partial',
    })))
  }
  const covered = entries.reduce((sum, row) => ({
    count: sum.count + number(row?.count),
    bytes: sum.bytes + number(row?.bytes),
    errors: sum.errors + number(row?.errors),
  }), { count: 0, bytes: 0, errors: 0 })
  const missing = {
    count: Math.max(0, expected.count - covered.count),
    bytes: Math.max(0, expected.bytes - covered.bytes),
    errors: Math.max(0, expected.errors - covered.errors),
  }
  if (missing.count || missing.bytes || missing.errors) entries.push(tracked(missing))
  const summary = compactResourceCostAttribution(entries, options)
  return {
    ...summary,
    coverage: {
      ...summary.coverage,
      windows: modernWindows + legacyWindows,
      modern_windows: modernWindows,
      legacy_windows: legacyWindows,
      not_recorded_events: summary.rows.filter((row) => row.classification === 'not_recorded').reduce((sum, row) => sum + row.count, 0),
      not_recorded_bytes: summary.rows.filter((row) => row.classification === 'not_recorded').reduce((sum, row) => sum + row.bytes, 0),
      totals_discrepancy: expected.count !== summary.totals.count || expected.bytes !== summary.totals.bytes || expected.errors !== summary.totals.errors,
      measurement: 'backend_observed_payload_bytes_not_invoice_cost',
    },
  }
}
