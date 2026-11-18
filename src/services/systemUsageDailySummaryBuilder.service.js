import { createHash } from 'node:crypto'

export const SYSTEM_USAGE_COUNTER_FIELDS = Object.freeze([
  'count', 'bytes', 'errors', 'requests', 'attempts', 'successes',
  'failures', 'ingress_bytes', 'egress_bytes', 'object_bytes',
])

const DAY_MS = 86_400_000
const KH_OFFSET_MS = 25_200_000
const BREAKDOWN_KEYS = ['provider', 'service_id', 'kind', 'dependency', 'feature']

export function systemUsageCambodiaDay(day) {
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    throw new RangeError('Invalid Cambodia summary date.')
  }
  const local = Date.parse(`${day}T00:00:00.000Z`)
  if (!Number.isFinite(local) || new Date(local).toISOString().slice(0, 10) !== day) {
    throw new RangeError('Invalid Cambodia calendar day.')
  }
  const start = local - KH_OFFSET_MS
  return { day, from: new Date(start).toISOString(), to: new Date(start + DAY_MS).toISOString() }
}

function addCounter(a, b, field) {
  if (b === null || b === undefined) return a
  if (!Number.isSafeInteger(b) || b < 0) throw new RangeError(`Invalid usage counter: ${field}`)
  const value = (a ?? 0) + b
  if (!Number.isSafeInteger(value)) throw new RangeError(`Usage counter overflow: ${field}`)
  return value
}

function emptyCounters() {
  return Object.fromEntries(SYSTEM_USAGE_COUNTER_FIELDS.map((field) => [field, null]))
}

function mergeCounters(to, from) {
  for (const field of SYSTEM_USAGE_COUNTER_FIELDS) {
    to[field] = addCounter(to[field], from?.[field], field)
  }
  return to
}

function sameCounters(a, b) {
  return SYSTEM_USAGE_COUNTER_FIELDS.every((field) => (a?.[field] ?? null) === (b?.[field] ?? null))
}

function sha256(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function stringDimension(value) {
  return value === undefined || value === null ? '' : String(value)
}

export function buildSystemUsageDailySummary({ day, sourceKind = 'observed_aggregates', archives } = {}) {
  const period = systemUsageCambodiaDay(day)
  if (!/^[a-z0-9_:-]{1,80}$/.test(sourceKind)) throw new TypeError('Invalid summary source kind.')
  if (!Array.isArray(archives) || archives.length === 0 || archives.length > 512) {
    throw new RangeError('Daily summary requires between 1 and 512 verified archives.')
  }

  const ordered = [...archives].sort((a, b) =>
    String(a?.entry?.window_from).localeCompare(String(b?.entry?.window_from)) ||
    String(a?.entry?.archive_key).localeCompare(String(b?.entry?.archive_key)))
  const seenKeys = new Set()
  const groups = new Map()
  const totals = emptyCounters()
  let sourceRows = 0
  let groupRows = 0
  let measuredMs = 0
  let previousEnd = Date.parse(period.from)
  let fullSourceCoverage = true
  const archiveKeys = []

  for (const item of ordered) {
    const entry = item?.entry
    const recovered = item?.recovered
    const summary = recovered?.summary
    if (!entry || !summary?.complete_group_list || !Array.isArray(summary.groups) ||
        entry.source_kind !== sourceKind || !/^[0-9a-f]{64}$/.test(String(entry.archive_key))) {
      throw new Error('Daily summary requires valid, fully verified source archives.')
    }
    if (seenKeys.has(entry.archive_key)) throw new Error('Duplicate archive in daily summary.')
    seenKeys.add(entry.archive_key)
    const start = Date.parse(entry.window_from)
    const end = Date.parse(entry.window_to)
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < Date.parse(period.from) ||
        end > Date.parse(period.to) || start >= end) {
      throw new RangeError('Archive crosses the Cambodia date boundary; split it before summarizing.')
    }
    if (start < previousEnd) throw new Error('Overlapping archive windows could double-count usage.')
    previousEnd = end
    measuredMs += end - start
    if (entry.source_rows !== summary.source_rows || entry.group_count !== summary.group_count ||
        entry.manifest?.sha256 !== recovered?.manifest_sha256 || !sameCounters(entry.totals, summary.totals)) {
      throw new Error('Archive index totals or verification digest do not match source content.')
    }
    archiveKeys.push(entry.archive_key)
    sourceRows = addCounter(sourceRows, summary.source_rows, 'source_rows')
    groupRows = addCounter(groupRows, summary.group_count, 'group_count')
    mergeCounters(totals, summary.totals)
    fullSourceCoverage = fullSourceCoverage && entry.source_complete === true &&
      entry.coverage?.event_level_complete === true

    for (const group of summary.groups) {
      const dimensions = Object.fromEntries(BREAKDOWN_KEYS.map((field) =>
        [field, stringDimension(group.dimensions?.[field])]))
      const key = JSON.stringify(dimensions)
      const current = groups.get(key) || { dimensions, counters: emptyCounters() }
      mergeCounters(current.counters, group.counters)
      groups.set(key, current)
    }
  }

  const checkTotals = emptyCounters()
  for (const group of groups.values()) mergeCounters(checkTotals, group.counters)
  if (!sameCounters(totals, checkTotals)) throw new Error('Daily grouped counters did not reconcile.')

  const breakdown = [...groups.values()].sort((a, b) =>
    (b.counters.bytes ?? 0) - (a.counters.bytes ?? 0) ||
    (b.counters.errors ?? 0) - (a.counters.errors ?? 0) ||
    JSON.stringify(a.dimensions).localeCompare(JSON.stringify(b.dimensions)))
  const coverage = {
    archived_windows: archiveKeys.length,
    archived_group_rows: groupRows,
    observed_window_seconds: Math.floor(measuredMs / 1000),
    expected_window_seconds: 86_400,
    full_day_windows: measuredMs === DAY_MS,
    event_level_complete: fullSourceCoverage && measuredMs === DAY_MS,
    status: fullSourceCoverage && measuredMs === DAY_MS ? 'complete' : 'partial',
    archive_validation: 'sha256_verified',
    counter_reconciliation: 'verified',
    provider_billing_verified: false,
  }
  const archiveSetSha256 = sha256(archiveKeys)
  const payload = {
    summary_date: day,
    source_kind: sourceKind,
    archive_set_sha256: archiveSetSha256,
    archive_keys: archiveKeys,
    source_rows: sourceRows,
    group_count: groups.size,
    totals,
    breakdown,
    coverage,
  }
  return { ...payload, summary_sha256: sha256(payload) }
}
