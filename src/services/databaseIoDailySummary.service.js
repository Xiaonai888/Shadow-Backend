const DAY = 86400000
const OFFSET = 7 * 3600000
const MAX_INTERVALS = 128
const KEYS = ['calls','rows','exec_ms','read_bytes','hit_bytes','dirty_bytes','written_bytes','temp_read_bytes','temp_written_bytes','wal_bytes']
const STATES = new Set(['observed','partial','baseline_changed'])

export function databaseIoDay(time) {
  const ms = typeof time === 'number' ? time : Date.parse(time)
  if (!Number.isFinite(ms)) throw new Error('IO_INVALID_TIMESTAMP')
  return new Date(ms + OFFSET).toISOString().slice(0, 10)
}

export function databaseIoDayRange(days, now = Date.now()) {
  if (!Number.isInteger(days) || days < 1 || days > 30 || !Number.isFinite(now)) throw new Error('IO_INVALID_RANGE')
  return Array.from({ length: days }, (_, i) => databaseIoDay(now - (days - 1 - i) * DAY))
}

export function databaseIoIntervalId(interval) {
  const from = Date.parse(interval?.from), to = Date.parse(interval?.to)
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 1000000000000 || to <= from || to > 9999999999999 || !STATES.has(interval.status)) throw new Error('IO_INVALID_INTERVAL')
  return `${from}-${to}`
}

function counters(input) {
  return Object.fromEntries(KEYS.map(key => {
    const n = input?.[key]
    return [key, typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null]
  }))
}

export function compactDatabaseIoInterval(interval) {
  const id = databaseIoIntervalId(interval)
  return { id, from: interval.from, to: interval.to, status: interval.status,
    reasons: (interval.reasons || []).slice(0, 20),
    totals: interval.totals ? counters(interval.totals) : null,
    features: (interval.features || []).slice(0, 64).map(row => ({ feature: String(row.feature).slice(0, 80), ...counters(row) })),
    database: interval.database || null,
    coverage: interval.coverage || null }
}

export function mergeDatabaseIoDay(existing, interval) {
  const day = databaseIoDay(interval.to)
  const item = compactDatabaseIoInterval(interval)
  const entries = existing ? existing.intervals : []
  if (existing && (existing.version !== 1 || existing.day !== day || !Array.isArray(entries) || entries.length > MAX_INTERVALS)) throw new Error('IO_INVALID_DAILY_OBJECT')
  const merged = new Map(entries.map(row => [row.id, row]))
  if (!merged.has(item.id)) merged.set(item.id, item)
  const intervals = [...merged.values()].sort((a, b) => Date.parse(a.to) - Date.parse(b.to))
  if (intervals.length > MAX_INTERVALS) throw new Error('IO_DAILY_INTERVAL_LIMIT')
  return { version: 1, day, timezone: 'Asia/Phnom_Penh', allocation: 'interval_end_day', intervals }
}

export function summarizeDatabaseIoDay(record) {
  if (!record || record.version !== 1 || !Array.isArray(record.intervals) || record.intervals.length > MAX_INTERVALS) throw new Error('IO_INVALID_DAILY_OBJECT')
  const totals = Object.fromEntries(KEYS.map(k => [k, null]))
  const features = new Map()
  const accepted = []
  let overlaps = 0, partial = 0, missing = 0, coveredSeconds = 0, crossDay = 0
  let lastEnd = 0
  for (const row of [...record.intervals].sort((a,b) => Date.parse(a.from) - Date.parse(b.from))) {
    if (row.status === 'baseline_changed' || !row.totals) { missing++; continue }
    const start = Date.parse(row.from), end = Date.parse(row.to)
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) { missing++; continue }
    if (start < lastEnd) { overlaps++; continue }
    lastEnd = end
    coveredSeconds += (end-start)/1000
    if (databaseIoDay(start) !== record.day) crossDay++
    if (row.status === 'partial') partial++
    accepted.push(row.id)
    for (const k of KEYS) if (Number.isFinite(row.totals[k])) totals[k] = (totals[k] ?? 0) + row.totals[k]
    for (const feature of row.features || []) {
      if (!features.has(feature.feature)) features.set(feature.feature, Object.fromEntries(KEYS.map(k => [k, null])))
      const target = features.get(feature.feature)
      for (const k of KEYS) if (Number.isFinite(feature[k])) target[k] = (target[k] ?? 0) + feature[k]
    }
  }
  return { day: record.day, timezone: record.timezone, allocation: record.allocation, totals, features: [...features].map(([feature, value]) => ({ feature, ...value })), coverage: { intervals: accepted.length, partial, missing, overlaps_excluded: overlaps, covered_seconds: coveredSeconds, cross_day_intervals: crossDay }, note: 'Observed PostgreSQL counters, not physical disk totals or provider burst balance. Intervals assigned to ending day; missing periods are not zero.' }
}
