const SOURCE_KEYS = Object.freeze(['web', 'admin', 'shared'])

function safeNumber(value) {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : null
}

function blankSource() {
  return { observed_api_bytes: 0, observed_operations: 0, observed_rows: 0 }
}

export function classifyResourceCostFeature(feature, kind = '') {
  const name = String(feature || '').trim().toLowerCase()
  const type = String(kind || '').trim().toLowerCase()
  if (type === 'unclassified' || type === 'overflow') return 'shared'
  if (!name || ['unknown', 'unclassified', 'overflow', 'other', 'background', 'root', 'system'].includes(name)) return 'shared'
  if (/^admin(?:$|[-_.:])/.test(name)) return 'admin'
  return 'web'
}

export function partitionResourceCostApplication(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return { web: null, admin: null, shared: null, all: null, available: false }
  }
  const grouped = { web: blankSource(), admin: blankSource(), shared: blankSource() }
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const key = classifyResourceCostFeature(row.feature, row.kind)
    const bytes = safeNumber(row.observed_bytes)
    const operations = safeNumber(row.observed_events)
    if (bytes === null && operations === null) continue
    grouped[key].observed_api_bytes += bytes ?? 0
    grouped[key].observed_operations += operations ?? 0
    grouped[key].observed_rows += 1
  }
  const measuredRows = SOURCE_KEYS.reduce((sum, key) => sum + grouped[key].observed_rows, 0)
  if (!measuredRows) return { web: null, admin: null, shared: null, all: null, available: false }
  const all = SOURCE_KEYS.reduce((total, key) => ({
    observed_api_bytes: total.observed_api_bytes + grouped[key].observed_api_bytes,
    observed_operations: total.observed_operations + grouped[key].observed_operations,
    observed_rows: total.observed_rows + grouped[key].observed_rows,
  }), blankSource())
  return { ...grouped, all, available: true }
}

export function resourceCostVerifiedNumber(value) {
  return safeNumber(value)
}

export function summarizeResourceCostSource(rows, key, { complete = false } = {}) {
  const values = rows.map((row) => row?.sources?.[key] || null)
  const observed = values.filter((item) => item && safeNumber(item.observed_api_bytes) !== null)
  const invoiced = values.map((item) => safeNumber(item?.verified_cost_usd))
  return {
    observed_api_bytes: observed.length ? observed.reduce((sum, item) => sum + item.observed_api_bytes, 0) : null,
    observed_operations: observed.length ? observed.reduce((sum, item) => sum + (safeNumber(item.observed_operations) ?? 0), 0) : null,
    observed_days: observed.length,
    expected_days: rows.length,
    verified_cost_usd: complete && rows.length && invoiced.every((amount) => amount !== null)
      ? invoiced.reduce((sum, amount) => sum + amount, 0)
      : null,
    provider_costs_usd: { render: null, supabase: null, cloudflare_r2: null },
  }
}
