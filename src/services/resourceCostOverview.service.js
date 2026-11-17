import { supabase } from '../config/supabase.js'
import { getResourceCostReport } from './resourceCostReportData.service.js'
import {
  partitionResourceCostApplication,
  resourceCostVerifiedNumber,
  summarizeResourceCostSource,
} from './resourceCostOverviewAttribution.service.js'

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS
const OFFSET_MS = 7 * HOUR_MS
const CACHE_MS = 15 * 60 * 1000
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
    end_exclusive: endExclusive,
    from_date: fromDate,
    through_date: dates.length ? dates[dates.length - 1] : null,
    granularity: mode === 'last12months' ? 'month' : 'day',
    timezone: 'Asia/Phnom_Penh',
    dates,
  }
}

async function savedSnapshots(database, period) {
  if (!period.dates.length) return []
  const { data, error } = await database.from('resource_cost_daily_snapshots')
    .select('snapshot_date,captured_at,status,payload')
    .gte('snapshot_date', period.from_date)
    .lt('snapshot_date', period.end_exclusive)
    .order('snapshot_date', { ascending: true })
    .limit(370)
  if (error) throw new Error(`Cost Overview snapshots unavailable: ${error.message || String(error)}`)
  if (!Array.isArray(data)) throw new Error('Cost Overview snapshots returned invalid data.')
  return data
}

function makeSource(observed, verifiedCost = null) {
  return {
    observed_api_bytes: observed?.observed_api_bytes ?? null,
    observed_operations: observed?.observed_operations ?? null,
    verified_cost_usd: verifiedCost,
    provider_costs_usd: { render: null, supabase: null, cloudflare_r2: null },
  }
}

function makeDay(date, reportDay, snapshot) {
  const application = partitionResourceCostApplication(reportDay?.application_attribution)
  const invoice = resourceCostVerifiedNumber(snapshot?.payload?.invoiced_cost_usd)
  const measuredRender = Number(reportDay?.render?.observed_service_hours) > 0
    ? resourceCostVerifiedNumber(reportDay?.render?.total_bytes)
    : resourceCostVerifiedNumber(snapshot?.payload?.render_total_bytes)
  return {
    date,
    label: date.slice(5),
    granularity: 'day',
    verified_cost_usd: invoice,
    render_outbound_bytes: measuredRender,
    sources: {
      all: makeSource(application.all, invoice),
      web: makeSource(application.web),
      admin: makeSource(application.admin),
      shared: makeSource(application.shared),
    },
    coverage: {
      recorded_snapshot: Boolean(snapshot),
      recorded_application: application.available,
      recorded_render: measuredRender !== null,
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
    const date = `${month}-01`
    const label = new Date(`${date}T00:00:00.000Z`).toLocaleDateString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' })
    const sources = Object.fromEntries(SOURCES.map((source) => [source, summarizeResourceCostSource(rows, source, { complete: source === 'all' })]))
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
  const reportReader = dependencies.reportReader || getResourceCostReport
  const [snapshots, report] = await Promise.all([
    savedSnapshots(database, period),
    period.dates.length && period.mode !== 'last12months'
      ? reportReader({
          from: startUtc(period.from_date),
          to: startUtc(period.end_exclusive),
          includeApplication: true,
        })
      : Promise.resolve(null),
  ])
  const snapshotsByDate = new Map(snapshots.map((row) => [row.snapshot_date, row]))
  const reportByDate = new Map((report?.days || []).map((row) => [row.date, row]))
  const days = period.dates.map((date) => makeDay(date, reportByDate.get(date), snapshotsByDate.get(date)))
  const series = period.granularity === 'month' ? monthRows(days) : days
  const totals = Object.fromEntries(SOURCES.map((source) => [source, summarizeResourceCostSource(days, source, { complete: source === 'all' })]))
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
      application_attribution: report?.sources?.application?.status || 'not_available',
      render_measurements: report?.sources?.render?.rows || 0,
      attribution_method: 'api_feature_partial',
      verified_source_costs_available: false,
    },
    notes: [
      'Web and Admin use observed API feature categories, not verified client-origin or bill attribution.',
      'Shared includes background and unknown API traffic. Provider invoices cannot be split by these proxy measurements.',
      'Missing daily invoices are unknown, not zero. Twelve-month history uses saved snapshots, not live provider queries.',
    ],
  }
}

export async function getResourceCostOverview({ period = 'last7', now = new Date() } = {}, dependencies = {}) {
  const selection = selectedPeriod(period, now)
  if (dependencies.database || dependencies.reportReader) return readOverview(selection, dependencies)
  const key = `${period}:${selection.today}`
  const current = Date.now()
  const cached = cache.get(key)
  if (cached && cached.expires > current) return cached.pending
  const pending = readOverview(selection)
  cache.set(key, { expires: current + CACHE_MS, pending })
  while (cache.size > 8) cache.delete(cache.keys().next().value)
  try {
    return await pending
  } catch (error) {
    if (cache.get(key)?.pending === pending) cache.delete(key)
    throw error
  }
}
