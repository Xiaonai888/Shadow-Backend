function number(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0
}

function sourceRows(window) {
  const payload = window?.payload || {}
  const modern = payload.resource_cost_attribution
  if (modern?.version === 1 && Array.isArray(modern.rows)) return {
    rows: modern.rows,
    detail: 'route',
  }
  if (Array.isArray(payload.summary_rows)) return {
    rows: payload.summary_rows,
    detail: 'feature',
  }
  return {
    rows: Array.isArray(payload.top_rows) ? payload.top_rows : [],
    detail: 'legacy_partial',
  }
}

export function resourceCostAttributionReportRows(window, timeField = 'window_start') {
  const time = window?.[timeField]
  if (!time || !Number.isFinite(Date.parse(time))) return []
  const source = sourceRows(window)
  const rows = source.rows.map((row) => {
    const kind = String(row?.kind || 'unknown')
    const feature = String(row?.feature || 'unknown')
    const classification = String(row?.classification || (
      kind === 'unclassified' ? 'not_recorded' : source.detail === 'feature' ? 'feature_only' : source.detail
    ))
    return {
      hour_start: time,
      feature,
      kind,
      dependency: String(row?.dependency || 'UNKNOWN'),
      route: String(row?.route || row?.source_route || (source.detail === 'feature' ? 'FEATURE ONLY' : 'UNKNOWN')),
      target: String(row?.target || row?.target_path || 'MULTIPLE'),
      entry_point: String(row?.entry_point || (feature === 'background' ? 'background' : feature.startsWith('admin') ? 'admin_api' : 'unknown_entry')),
      classification,
      count: number(row?.count),
      bytes: number(row?.bytes),
      errors: number(row?.errors),
    }
  })
  const count = rows.reduce((sum, row) => sum + row.count, 0)
  const bytes = rows.reduce((sum, row) => sum + row.bytes, 0)
  const errors = rows.reduce((sum, row) => sum + row.errors, 0)
  const missing = {
    count: Math.max(0, number(window?.request_count) - count),
    bytes: Math.max(0, number(window?.bytes) - bytes),
    errors: Math.max(0, number(window?.errors) - errors),
  }
  if (missing.count || missing.bytes || missing.errors) rows.push({
    hour_start: time, feature: 'unattributed', kind: 'unclassified', dependency: 'UNKNOWN',
    route: 'NOT RECORDED', target: 'UNKNOWN', entry_point: 'unknown_entry',
    classification: 'not_recorded', ...missing,
  })
  return rows
}
