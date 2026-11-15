const MAX_EXACT_ROUTES = 100
const MAX_OTHER_GROUPS = 40

function number(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0
}

function safeLabel(value, fallback, limit = 160) {
  const text = String(value ?? '').trim().replace(/[\u0000-\u001f\u007f]/g, '')
  return (text || fallback).slice(0, limit)
}

function safePath(value) {
  const text = safeLabel(value, '/', 500).split(/[?#]/, 1)[0]
  if (text === 'BACKGROUND' || text === 'OVERFLOW' || text === 'UNKNOWN') return text
  return text.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, ':id')
    .replace(/\/(?:\d+|[0-9a-f]{20,}|[^/\s]*@[^/\s]*|[A-Za-z0-9_-]{48,})(?=\/|$)/gi, '/:id')
    .replace(/\b(?:eyJ[A-Za-z0-9_-]{18,})\b/g, ':token')
    .slice(0, 160)
}

function entryPoint(route, feature) {
  if (route === 'BACKGROUND' || feature === 'background') return 'background'
  if (route === 'OVERFLOW' || feature === 'overflow') return 'monitor_overflow'
  if (/^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) \/api\/admin(?:\/|$)/i.test(route) || feature.startsWith('admin')) return 'admin_api'
  if (/^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) \//i.test(route)) return 'public_api'
  return 'unknown_entry'
}

function normalize(row) {
  const feature = safeLabel(row?.feature, 'unknown', 80).toLowerCase()
  const kind = safeLabel(row?.kind, 'unknown', 48).toLowerCase()
  const dependency = safeLabel(row?.dependency, 'UNKNOWN', 48).toUpperCase()
  const classification = safeLabel(row?.classification, 'exact_route', 32)
  const sourceMethod = safeLabel(row?.source_method, 'UNKNOWN', 16).toUpperCase()
  const operationMethod = safeLabel(row?.operation_method, 'UNKNOWN', 16).toUpperCase()
  const route = row?.route
    ? safeLabel(row.route, 'UNKNOWN', 220)
    : sourceMethod === 'BACKGROUND' || row?.source_path === 'BACKGROUND'
      ? 'BACKGROUND'
      : row?.source_path === 'OVERFLOW'
        ? 'OVERFLOW'
        : `${sourceMethod} ${safePath(row?.source_path)}`
  const target = row?.target
    ? safeLabel(row.target, 'UNKNOWN', 220)
    : kind === 'external_request'
      ? `${operationMethod} ${safePath(row?.target_path)}`
      : 'CLIENT'
  const point = safeLabel(row?.entry_point, entryPoint(route, feature), 32)
  const inferred = route === 'OVERFLOW' || feature === 'overflow' ? 'monitor_overflow' : classification
  return {
    feature, kind, dependency, route, target, entry_point: point,
    classification: inferred,
    count: number(row?.count), bytes: number(row?.bytes), errors: number(row?.errors),
  }
}

function key(row) {
  return [row.feature, row.kind, row.dependency, row.route, row.target, row.entry_point, row.classification].join('\u001f')
}

function add(target, source) {
  target.count += source.count
  target.bytes += source.bytes
  target.errors += source.errors
}

function order(a, b) {
  return b.bytes - a.bytes || b.count - a.count || key(a).localeCompare(key(b))
}

function put(map, row) {
  const identity = key(row)
  const existing = map.get(identity)
  if (existing) add(existing, row)
  else map.set(identity, { ...row })
}

function collapsed(row, classification) {
  return {
    feature: classification === 'other_features' ? 'other_features' : row.feature,
    kind: row.kind,
    dependency: row.dependency,
    route: classification === 'other_features' ? 'OTHER FEATURES' : 'OTHER ROUTES',
    target: 'MULTIPLE',
    entry_point: row.entry_point,
    classification,
    count: row.count,
    bytes: row.bytes,
    errors: row.errors,
  }
}

export function compactResourceCostAttribution(input, options = {}) {
  const maxExactRoutes = Math.max(1, Math.min(200, number(options.maxExactRoutes) || MAX_EXACT_ROUTES))
  const maxOtherGroups = Math.max(1, Math.min(80, number(options.maxOtherGroups) || MAX_OTHER_GROUPS))
  const grouped = new Map()
  const totals = { count: 0, bytes: 0, errors: 0 }
  for (const raw of input || []) {
    if (!raw || typeof raw !== 'object') continue
    const row = normalize(raw)
    add(totals, row)
    if (row.count || row.bytes || row.errors) put(grouped, row)
  }
  const all = [...grouped.values()].sort(order)
  const priority = all.filter((row) => row.classification !== 'exact_route')
  const exact = all.filter((row) => row.classification === 'exact_route')
  const selected = exact.slice(0, maxExactRoutes)
  const remaining = exact.slice(maxExactRoutes)
  const byFeature = new Map()
  for (const row of remaining) put(byFeature, collapsed(row, 'other_routes'))
  const featureGroups = [...byFeature.values()].sort(order)
  const byDependency = new Map()
  for (const row of featureGroups.slice(maxOtherGroups)) put(byDependency, collapsed(row, 'other_features'))
  const rows = [...selected, ...priority, ...featureGroups.slice(0, maxOtherGroups), ...byDependency.values()].sort(order)
  const resultTotals = rows.reduce((acc, row) => {
    add(acc, row)
    return acc
  }, { count: 0, bytes: 0, errors: 0 })
  if (resultTotals.count !== totals.count || resultTotals.bytes !== totals.bytes || resultTotals.errors !== totals.errors) {
    throw new Error('Resource Cost attribution totals do not reconcile.')
  }
  return {
    version: 1,
    totals,
    rows,
    coverage: {
      measured_groups: all.length,
      exact_route_groups: exact.length,
      collapsed_route_groups: remaining.length,
      exact_routes_retained: selected.length,
      grouped_route_rows: featureGroups.length,
      overflow_events: rows.filter((row) => row.classification === 'monitor_overflow').reduce((sum, row) => sum + row.count, 0),
      complete_route_detail: remaining.length === 0 && !rows.some((row) => row.classification !== 'exact_route'),
    },
  }
}

export function summarizeResourceCostMinuteAttribution(rows) {
  return compactResourceCostAttribution(rows, { maxExactRoutes: 100, maxOtherGroups: 35 })
}
