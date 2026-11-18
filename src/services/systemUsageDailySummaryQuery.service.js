import { readSystemUsageDailySummary, listSystemUsageDailySummaries } from './systemUsageDailySummaryStore.service.js'
import { readSystemUsageGroupedArchive } from './systemUsageArchivePipeline.service.js'
import { systemUsageCambodiaDay, SYSTEM_USAGE_COUNTER_FIELDS } from './systemUsageDailySummaryBuilder.service.js'

const TODAY_TTL_MS = 2 * 60_000
const HISTORY_TTL_MS = 60 * 60_000
const CACHE_LIMIT = 32
const cache = new Map()

function currentCambodiaDay(now = Date.now()) {
  return new Date(now + 25_200_000).toISOString().slice(0, 10)
}

function datesBetween(from, to) {
  const first = systemUsageCambodiaDay(from)
  const last = systemUsageCambodiaDay(to)
  if (first.day > last.day) throw new RangeError('Start date cannot be after end date.')
  const days = []
  for (let time = Date.parse(`${from}T00:00:00.000Z`);
    time <= Date.parse(`${to}T00:00:00.000Z`); time += 86_400_000) {
    if (days.length >= 1096) throw new RangeError('Maximum Custom Date range is 1096 days.')
    days.push(new Date(time).toISOString().slice(0, 10))
  }
  return days
}

export async function getSystemUsageDailyOverview({
  from, to, sourceKind = 'observed_aggregates', client, now = Date.now(), forceRefresh = false,
} = {}) {
  const days = datesBetween(from, to)
  const key = `${sourceKind}:${from}:${to}`
  const expiryMs = to >= currentCambodiaDay(now) ? TODAY_TTL_MS : HISTORY_TTL_MS
  const cached = cache.get(key)
  if (!forceRefresh && cached?.expires > now) return cached.value

  const load = (async () => {
    const rows = []
    let offset = 0
    while (true) {
      const page = await listSystemUsageDailySummaries({
        from, to, sourceKind, offset, limit: 100, ...(client ? { client } : {}),
      })
      if (!Array.isArray(page?.rows)) throw new Error('Invalid daily summary listing.')
      rows.push(...page.rows)
      if (page.next_offset === null || page.next_offset === undefined) break
      if (page.next_offset <= offset || page.next_offset > 1096) throw new Error('Invalid daily summary cursor.')
      offset = page.next_offset
    }
    const byDay = new Map(rows.map((row) => [row.summary_date, row]))
    const daily = days.map((day) => {
      const row = byDay.get(day)
      return row ? {
        day, totals: row.totals, breakdown_available: row.group_count > 0, coverage: row.coverage,
        archived_windows: row.coverage?.archived_windows ?? null,
        source_rows: row.source_rows, verified: row.coverage?.archive_validation === 'sha256_verified',
      } : { day, totals: null, breakdown_available: false, coverage: { status: 'missing' },
        archived_windows: 0, source_rows: null, verified: false }
    })
    const totals = Object.fromEntries(SYSTEM_USAGE_COUNTER_FIELDS.map((field) => [field, null]))
    for (const row of rows) {
      for (const field of SYSTEM_USAGE_COUNTER_FIELDS) {
        const amount = row.totals?.[field]
        if (amount === null || amount === undefined) continue
        if (!Number.isSafeInteger(amount) || amount < 0) throw new RangeError('Invalid persisted usage counter.')
        const sum = (totals[field] ?? 0) + amount
        if (!Number.isSafeInteger(sum)) throw new RangeError('Usage summary totals exceeded safe integer precision.')
        totals[field] = sum
      }
    }
    return {
      from, to, source_kind: sourceKind, timezone: 'Asia/Phnom_Penh',
      recorded_days: rows.length, expected_days: days.length, missing_days: days.length - rows.length,
      totals, daily, source: 'stored_daily_summaries',
      cost_usd: null, cost_status: 'provider_invoice_not_in_this_usage_summary',
    }
  })()

  cache.set(key, { expires: now + expiryMs, value: load })
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value)
  try { return await load } catch (error) {
    if (cache.get(key)?.value === load) cache.delete(key)
    throw error
  }
}

export async function getSystemUsageDailyArchiveGroupPage({
  day, archiveKey, sourceKind = 'observed_aggregates', offset = 0, limit = 50, client,
} = {}) {
  const summary = await readSystemUsageDailySummary({ day, sourceKind, ...(client ? { client } : {}) })
  if (!summary || !Array.isArray(summary.archive_keys) || !summary.archive_keys.includes(archiveKey)) {
    return null
  }
  return readSystemUsageGroupedArchive({ archiveKey, offset, limit, ...(client ? { client } : {}) })
}
