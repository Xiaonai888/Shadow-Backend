import { supabase } from '../config/supabase.js'
import {
  classifyResourceCostFeature,
  resourceCostVerifiedNumber,
  summarizeResourceCostSource,
} from './resourceCostOverviewAttribution.service.js'

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS
const OFFSET_MS = 7 * HOUR_MS
const SOURCES = ['all', 'web', 'admin', 'shared']
const MODES = new Set(['yesterday', 'last7', 'week', 'month', 'last30', 'last12months'])
const cache = new Map()

function dateFromMs(ms) {
  return new Date(ms).toISOString().slice(0, 10)
}

function shiftDay(date, count) {
  return dateFromMs(Date.parse(`${date}T00:00:00.000Z`) + count * DAY_MS)
}

function shiftMonth(date, count) {
  const [year, month] = date.split('-').map(Number)
  return dateFromMs(Date.UTC(year, month - 1 + count, 1))
}

function startUtc(date) {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) - OFFSET_MS).toISOString()
}

function selectedPeriod(mode, now) {
  if (!MODES.has(mode)) throw new RangeError('Unsupported Cost Overview period.')
  const ms = new Date(now).getTime()
  if (!Number.isFinite(ms)) throw new TypeError('Invalid Cost Overview time.')
  const today = dateFromMs(ms + OFFSET_MS)
  const yesterday = shiftDay(today, -1)
  const weekday = new Date(`${today}T00:00:00.000Z`).getUTCDay()
  const mondayOffset = (weekday + 6) % 7
  const fromDate = mode === 'yesterday' ? yesterday
    : mode === 'last7' ? shiftDay(today, -6)
      : mode === 'week' ? shiftDay(today, -mondayOffset)
        : mode === 'month' ? `${today.slice(0, 7)}-01`
          : mode === 'last30' ? shiftDay(today, -29)
            : shiftMonth(today, -11)
  const endExclusive = mode === 'yesterday' ? today : shiftDay(today, 1)
  const dates = []
  for (let date = fromDate; date < endExclusive; date = shiftDay(date, 1)) {
    if (dates.length >= 370) throw new RangeError('Cost Overview date range exceeds limit.')
    dates.push(date)
  }
  return {
    mode,
    today,
    from_date: fromDate,
    through_date: dates.at(-1) || null,
    end_exclusive: endExclusive,
    granularity: mode === 'last12months' ? 'month' : 'day',
    timezone: 'Asia/Phnom_Penh',
    dates,
  }
}

async function savedSnapshots(database, period) {
  if (!period.dates.length) return []
  const { data, error } = await database.from('resource_cost_daily_snapshots')
    .select('snapshot_date,status,payload')
    .gte('snapshot_date', period.from_date)
    .lt('snapshot_date', period.end_exclusive)
    .order('snapshot_date', { ascending: true })
    .limit(370)
  if (error) throw new Error('Cost Overview daily snapshots unavailable.', { cause: error })
  if (!Array.isArray(data)) throw new Error('Cost Overview snapshots returned invalid data.')
  return data
}

async function savedUsage(database, period) {
  if (!period.dates.length) return []
  const fields = period.granularity === 'month'
    ? 'summary_date,totals,coverage,source_kind'
    : 'summary_date,totals,coverage,source_kind,breakdown'
  const { data, error } = await database.from('system_usage_daily_summaries')
    .select(fields)
    .eq('source_kind', 'observed_aggregates')
    .gte('summary_date', period.from_date)
    .lt('summary_date', period.end_exclusive)
    .order('summary_date', { ascending: true })
    .limit(370)
  if (error) throw new Error('Cost Overview daily usage summaries unavailable.', { cause: error })
  if (!Array.isArray(data)) throw new Error('Cost Overview daily summaries returned invalid data.')
  return data
}

async function recentRender(database, period) {
  if (!period.dates.includes(period.today)) return null
  const { data, error } = await database.from('render_bandwidth_hourly')
    .select('service_id,hour_start,total_bytes')
    .gte('hour_start', startUtc(period.today))
    .lt('hour_start', startUtc(shiftDay(period.today, 1)))
    .order('hour_start', { ascending: false })
    .limit(1000)
  if (error) {
    console.error('RESOURCE_COST_OVERVIEW_RENDER_TODAY_ERROR:', error?.message || error)
    return { total: null, complete: false }
  }
  if (!Array.isArray(data)) return { total: null, complete: false }
  let total = 0
  const ids = new Set()
  for (const row of data) {
    const bytes = resourceCostVerifiedNumber(row.total_bytes)
    if (bytes === null) return { total: null, complete: false }
    const key = `${row.service_id || ''}:${row.hour_start || ''}`
    if (ids.has(key)) return { total: null, complete: false }
    ids.add(key)
    total += bytes
  }
  return { total: data.length && data.length < 1000 ? total : null, complete: data.length < 1000 }
}

function summarySource(usage) {
  const rawBytes = usage?.totals?.bytes
  const rawCount = usage?.totals?.count
  const bytes = resourceCostVerifiedNumber(rawBytes)
  const operations = resourceCostVerifiedNumber(rawCount)
  if (bytes === null && operations === null) return null
  return { observed_api_bytes: bytes, observed_operations: operations }
}

function splitBySource(usage) {
  const all = summarySource(usage)
  const empty = { all, web: null, admin: null, shared: null }
  if (!all || !Array.isArray(usage?.breakdown) || !usage.breakdown.length) return empty
  if (all.observed_api_bytes === null || all.observed_operations === null) return empty
  const groups = {
    web: { observed_api_bytes: 0, observed_operations: 0 },
    admin: { observed_api_bytes: 0, observed_operations: 0 },
    shared: { observed_api_bytes: 0, observed_operations: 0 },
  }
  let observedBytes = 0
  let observedCount = 0
  for (const group of usage.breakdown) {
    const bytes = resourceCostVerifiedNumber(group?.counters?.bytes)
    const count = resourceCostVerifiedNumber(group?.counters?.count)
    if (bytes === null || count === null) return empty
    const key = classifyResourceCostFeature(group?.dimensions?.feature, group?.dimensions?.kind)
    groups[key].observed_api_bytes += bytes
    groups[key].observed_operations += count
    observedBytes += bytes
    observedCount += count
  }
  if (observedBytes !== all.observed_api_bytes || observedCount !== all.observed_operations) return empty
  return { all, ...groups }
}

function makeSource(observed, verifiedCost = null) {
  return {
    observed_api_bytes: observed?.observed_api_bytes ?? null,
    observed_operations: observed?.observed_operations ?? null,
    verified_cost_usd: verifiedCost,
    provider_costs_usd: { render: null, supabase: null, cloudflare_r2: null },
  }
}

function makeDay(date, usage, snapshot, renderToday) {
  const values = splitBySource(usage)
  const invoice = resourceCostVerifiedNumber(snapshot?.payload?.invoiced_cost_usd)
  const archivedRender = resourceCostVerifiedNumber(snapshot?.payload?.render_total_bytes)
  const measuredRender = date === renderToday?.date
    ? renderToday.total ?? archivedRender
    : archivedRender
  return {
    date,
    label: date.slice(5),
    granularity: 'day',
    verified_cost_usd: invoice,
    render_outbound_bytes: measuredRender,
    sources: {
      all: makeSource(values.all, invoice),
      web: makeSource(values.web),
      admin: makeSource(values.admin),
      shared: makeSource(values.shared),
    },
    coverage: {
      recorded_snapshot: Boolean(snapshot),
      recorded_application: Boolean(values.all),
      recorded_render: measuredRender !== null,
      observed_usage_status: usage?.coverage?.status || 'missing',
      invoiced_cost: invoice === null ? 'unavailable' : 'recorded',
    },
  }
}

function sumAvailable(rows, field) {
  const numbers = rows.map((row) => resourceCostVerifiedNumber(row?.[field])).filter((value) => value !== null)
  return numbers.length ? numbers.reduce((sum, value) => sum + value, 0) : null
}

function monthRows(days) {
  const groups = new Map()
  for (const day of days) {
    const month = day.date.slice(0, 7)
    if (!groups.has(month)) groups.set(month, [])
    groups.get(month).push(day)
  }
  return [...groups].map(([month, rows]) => {
    const label = new Date(`${month}-01T00:00:00.000Z`)
      .toLocaleDateString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' })
    const sources = Object.fromEntries(SOURCES.map((source) => [source,
      summarizeResourceCostSource(rows, source, { complete: source === 'all' })]))
    return {
      date: month,
      label,
      granularity: 'month',
      days: rows.length,
      verified_cost_usd: sources.all.verified_cost_usd,
      render_outbound_bytes: sumAvailable(rows, 'render_outbound_bytes'),
      sources,
      coverage: {
        recorded_snapshot: rows.every((row) => row.coverage.recorded_snapshot),
        recorded_application: rows.every((row) => row.coverage.recorded_application),
        recorded_render: rows.every((row) => row.coverage.recorded_render),
        invoiced_cost: sources.all.verified_cost_usd === null ? 'unavailable' : 'recorded',
      },
    }
  })
}

async function readOverview(period, dependencies = {}) {
  const database = dependencies.database || supabase
  const [snapshots, dailyUsage, recent] = await Promise.all([
    savedSnapshots(database, period),
    savedUsage(database, period),
    recentRender(database, period),
  ])
  const snapshotsByDate = new Map(snapshots.map((row) => [row.snapshot_date, row]))
  const usageByDate = new Map(dailyUsage.map((row) => [row.summary_date, row]))
  const render = recent ? { ...recent, date: period.today } : null
  const days = period.dates.map((date) => makeDay(date, usageByDate.get(date), snapshotsByDate.get(date), render))
  const series = period.granularity === 'month' ? monthRows(days) : days
  const totals = Object.fromEntries(SOURCES.map((source) => [source,
    summarizeResourceCostSource(days, source, { complete: source === 'all' })]))
  return {
    period: {
      mode: period.mode,
      from_date: period.from_date,
      through_date: period.through_date,
      timezone: period.timezone,
      granularity: period.granularity,
      days: period.dates.length,
    },
    generated_at: new Date().toISOString(),
    totals,
    series,
    coverage: {
      daily_snapshots: snapshots.length,
      daily_usage_summaries: dailyUsage.length,
      application_attribution: dailyUsage.length ? 'stored_grouped_metrics_partial' : 'not_available',
      render_measurements: recent?.total !== null && recent?.total !== undefined ? 1 : 0,
      attribution_method: 'stored_daily_aggregate_feature_proxy',
      verified_source_costs_available: false,
    },
    notes: [
      'Daily usage comes from persisted aggregated monitor records, never a live full report.',
      'Web and Admin are API feature proxies, not verified traffic origin or bill attribution.',
      'Render bandwidth and observed application bytes are separate measurements and must not be added.',
      'Missing snapshots, incomplete monitored intervals, and unverified invoices remain unknown, never zero.',
    ],
  }
}

export async function getResourceCostOverview({ period = 'last7', now = new Date() } = {}, dependencies = {}) {
  const selection = selectedPeriod(period, now)
  if (dependencies.database) return readOverview(selection, dependencies)
  const key = `${period}:${selection.today}`
  const current = Date.now()
  const ttl = selection.dates.includes(selection.today) ? 2 * 60_000 : 15 * 60_000
  const existing = cache.get(key)
  if (existing && existing.expires > current) return existing.pending
  const pending = readOverview(selection)
  cache.set(key, { expires: current + ttl, pending })
  while (cache.size > 12) cache.delete(cache.keys().next().value)
  try {
    return await pending
  } catch (error) {
    if (cache.get(key)?.pending === pending) cache.delete(key)
    throw error
  }
}
