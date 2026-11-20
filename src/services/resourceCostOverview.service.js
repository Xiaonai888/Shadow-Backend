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
const MODES = new Set(['today', 'yesterday', 'last7', 'week', 'month', 'last30', 'last12months', 'custom'])
const RENDER_PAGE_SIZE = 750
const RENDER_MAX_ROWS = 5000
const RENDER_RECENT_DAYS = 7
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

function checkedCalendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new RangeError('Custom Date requires YYYY-MM-DD dates.')
  }
  const time = Date.parse(`${value}T00:00:00.000Z`)
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value) {
    throw new RangeError('Invalid Custom Date calendar date.')
  }
  return value
}

function selectedPeriod(mode, now, from, to) {
  if (!MODES.has(mode)) throw new RangeError('Unsupported Cost Overview period.')
  const ms = new Date(now).getTime()
  if (!Number.isFinite(ms)) throw new TypeError('Invalid Cost Overview time.')
  const today = dateFromMs(ms + OFFSET_MS)
  const yesterday = shiftDay(today, -1)
  const weekday = new Date(`${today}T00:00:00.000Z`).getUTCDay()
  const mondayOffset = (weekday + 6) % 7
  let fromDate
  let endExclusive
  if (mode === 'custom') {
    fromDate = checkedCalendarDate(from)
    const through = checkedCalendarDate(to)
    if (fromDate > through) throw new RangeError('Custom Date start is after end.')
    if ((Date.parse(`${through}T00:00:00.000Z`) - Date.parse(`${fromDate}T00:00:00.000Z`)) >= 370 * DAY_MS) {
      throw new RangeError('Custom Date supports a maximum of 370 days per request.')
    }
    endExclusive = shiftDay(through, 1)
  } else {
    fromDate = mode === 'today' ? today
      : mode === 'yesterday' ? yesterday
      : mode === 'last7' ? shiftDay(today, -6)
        : mode === 'week' ? shiftDay(today, -mondayOffset)
          : mode === 'month' ? `${today.slice(0, 7)}-01`
            : mode === 'last30' ? shiftDay(today, -29)
              : shiftMonth(today, -11)
    endExclusive = mode === 'yesterday' ? today : shiftDay(today, 1)
  }
  if (fromDate > today || endExclusive > shiftDay(today, 1)) {
    throw new RangeError('Cost Overview cannot include future days.')
  }
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

async function recentRenderByDay(database, period) {
  const recentStart = shiftDay(period.today, -(RENDER_RECENT_DAYS - 1))
  const firstDate = period.from_date > recentStart ? period.from_date : recentStart
  if (firstDate >= period.end_exclusive) return { byDay: new Map(), byHour: new Map() }
  const all = []
  for (let offset = 0; offset < RENDER_MAX_ROWS; offset += RENDER_PAGE_SIZE) {
    const { data, error } = await database.from('render_bandwidth_hourly')
      .select('service_id,hour_start,total_bytes')
      .gte('hour_start', startUtc(firstDate))
      .lt('hour_start', startUtc(period.end_exclusive))
      .order('hour_start', { ascending: true })
      .order('service_id', { ascending: true })
      .range(offset, offset + RENDER_PAGE_SIZE - 1)
    if (error) throw new Error('Cost Overview Render hourly history unavailable.', { cause: error })
    if (!Array.isArray(data)) throw new Error('Cost Overview Render hourly history returned invalid data.')
    all.push(...data)
    if (data.length < RENDER_PAGE_SIZE) break
    if (offset + RENDER_PAGE_SIZE >= RENDER_MAX_ROWS) {
      throw new RangeError('Cost Overview Render hourly history exceeds the safe query limit.')
    }
  }
  const seen = new Set()
  const byDay = new Map()
  const byHour = new Map()
  const firstMs = Date.parse(startUtc(firstDate))
  const lastMs = Date.parse(startUtc(period.end_exclusive))
  for (const row of all) {
    const hour = Date.parse(row.hour_start || '')
    const bytes = resourceCostVerifiedNumber(row.total_bytes)
    const service = String(row.service_id || '').trim()
    if (!service || !Number.isFinite(hour) || hour % HOUR_MS !== 0 ||
      hour < firstMs || hour >= lastMs || bytes === null || !Number.isSafeInteger(bytes)) {
      throw new Error('Cost Overview Render hourly history contains an invalid measurement.')
    }
    const key = `${service}:${hour}`
    if (seen.has(key)) throw new Error('Cost Overview Render hourly history contains a duplicate service-hour.')
    seen.add(key)
    const day = dateFromMs(hour + OFFSET_MS)
    const value = byDay.get(day) || { total: 0, observed_service_hours: 0, services: new Set() }
    value.total += bytes
    if (!Number.isSafeInteger(value.total)) throw new RangeError('Cost Overview Render daily bytes exceed safe precision.')
    value.observed_service_hours += 1
    value.services.add(service)
    byDay.set(day, value)
    const hourLabel = String(new Date(hour + OFFSET_MS).getUTCHours()).padStart(2, '0')
    const hourKey = `${day}T${hourLabel}:00`
    const hourly = byHour.get(hourKey) || { total: 0, observed_service_hours: 0, services: new Set() }
    hourly.total += bytes
    if (!Number.isSafeInteger(hourly.total)) throw new RangeError('Cost Overview Render hourly bytes exceed safe precision.')
    hourly.observed_service_hours += 1
    hourly.services.add(service)
    byHour.set(hourKey, hourly)
  }
  return { byDay, byHour }
}

async function savedHourlyUsage(database, period) {
  if (period.mode !== 'today' && period.mode !== 'yesterday') return null
  const date = period.from_date
  const start = Date.parse(startUtc(date))
  const end = start + DAY_MS
  const { data, error } = await database.from('system_usage_snapshots')
    .select('window_start,window_end,request_count,bytes')
    .gte('window_start', new Date(start).toISOString())
    .lt('window_start', new Date(end).toISOString())
    .order('window_start', { ascending: true })
    .limit(150)
  if (error) throw new Error('Cost Overview hourly application observations unavailable.', { cause: error })
  if (!Array.isArray(data) || data.length >= 150) {
    throw new Error('Cost Overview hourly application observations are incomplete or exceed the safe query limit.')
  }
  const hours = new Map()
  const seen = new Set()
  for (const row of data) {
    const from = Date.parse(row.window_start || '')
    const to = Date.parse(row.window_end || '')
    const bytes = resourceCostVerifiedNumber(row.bytes)
    const operations = resourceCostVerifiedNumber(row.request_count)
    if (!Number.isFinite(from) || to - from !== 15 * 60_000 || from % (15 * 60_000) !== 0 ||
      from < start || to > end || !Number.isSafeInteger(bytes) || !Number.isSafeInteger(operations)) {
      throw new Error('Cost Overview hourly application observation has an invalid 15-minute window.')
    }
    if (seen.has(from)) throw new Error('Cost Overview hourly application observations contain a duplicate window.')
    seen.add(from)
    const hour = new Date(from + OFFSET_MS).getUTCHours()
    const value = hours.get(hour) || { bytes: 0, operations: 0, windows: 0 }
    value.bytes += bytes
    value.operations += operations
    if (!Number.isSafeInteger(value.bytes) || !Number.isSafeInteger(value.operations)) {
      throw new RangeError('Cost Overview hourly application counters exceed safe precision.')
    }
    value.windows += 1
    hours.set(hour, value)
  }
  return hours
}

function hourRows(period, history, usageHours, now) {
  if (!usageHours) return []
  const date = period.from_date
  const start = Date.parse(startUtc(date))
  const current = new Date(now).getTime()
  return Array.from({ length: 24 }, (_, hour) => {
    const label = `${String(hour).padStart(2, '0')}:00`
    const key = `${date}T${label}`
    const render = history.byHour.get(key)
    const usage = usageHours.get(hour)
    const hourStart = start + hour * HOUR_MS
    const upcoming = hourStart > current
    const active = !upcoming && current < hourStart + HOUR_MS
    const renderStatus = render ? active ? 'in_progress' : 'observed_partial'
      : upcoming ? 'pending' : 'missing'
    const usageStatus = usage?.windows === 4 ? 'complete'
      : usage?.windows ? 'partial' : upcoming ? 'pending' : 'missing'
    return {
      date: key,
      label,
      granularity: 'hour',
      verified_cost_usd: null,
      render_outbound_bytes: render ? render.total : null,
      sources: {
        all: makeSource(usage ? { observed_api_bytes: usage.bytes, observed_operations: usage.operations } : null),
        web: makeSource(null),
        admin: makeSource(null),
        shared: makeSource(null),
      },
      coverage: {
        recorded_snapshot: Boolean(usage),
        recorded_application: Boolean(usage),
        recorded_render: Boolean(render),
        render_status: renderStatus,
        render_observed_service_hours: render?.observed_service_hours ?? 0,
        render_measurement_source: render ? 'stored_hourly' : 'missing',
        observed_usage_status: usageStatus,
        observed_application_windows: usage?.windows ?? 0,
        expected_application_windows: 4,
        invoiced_cost: 'unavailable',
      },
    }
  })
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

function makeDay(date, usage, snapshot, renderByDay, today) {
  const values = splitBySource(usage)
  const invoice = resourceCostVerifiedNumber(snapshot?.payload?.invoiced_cost_usd)
  const archivedRender = resourceCostVerifiedNumber(snapshot?.payload?.render_total_bytes)
  const archiveHours = resourceCostVerifiedNumber(snapshot?.payload?.render_observed_service_hours) ?? 0
  const hourly = renderByDay.get(date)
  const useHourly = Boolean(hourly?.observed_service_hours) &&
    (archivedRender === null || hourly.observed_service_hours > archiveHours)
  const measuredRender = useHourly ? hourly.total : archivedRender
  const observedHours = useHourly ? hourly.observed_service_hours : archiveHours
  const renderStatus = measuredRender === null ? 'missing'
    : date === today ? 'in_progress'
      : useHourly ? 'observed_partial'
        : String(snapshot?.payload?.render_coverage || snapshot?.status || 'partial')
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
      render_status: renderStatus,
      render_observed_service_hours: observedHours,
      render_measurement_source: useHourly ? 'stored_hourly' : archivedRender !== null ? 'stored_snapshot' : 'missing',
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
        render_status: rows.every((row) => row.coverage.render_status === 'complete') ? 'complete' : 'partial',
        invoiced_cost: sources.all.verified_cost_usd === null ? 'unavailable' : 'recorded',
      },
    }
  })
}

async function readOverview(period, dependencies = {}, now = new Date()) {
  const database = dependencies.database || supabase
  const [snapshots, dailyUsage, renderHistory, usageHours] = await Promise.all([
    savedSnapshots(database, period),
    savedUsage(database, period),
    recentRenderByDay(database, period),
    savedHourlyUsage(database, period),
  ])
  const snapshotsByDate = new Map(snapshots.map((row) => [row.snapshot_date, row]))
  const usageByDate = new Map(dailyUsage.map((row) => [row.summary_date, row]))
  const days = period.dates.map((date) => makeDay(date, usageByDate.get(date), snapshotsByDate.get(date), renderHistory.byDay, period.today))
  const hourlySeries = hourRows(period, renderHistory, usageHours, now)
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
      hourly_granularity: hourlySeries.length ? 'hour' : null,
      days: period.dates.length,
    },
    generated_at: new Date().toISOString(),
    totals,
    series,
    hourly_series: hourlySeries,
    coverage: {
      daily_snapshots: snapshots.length,
      daily_usage_summaries: dailyUsage.length,
      application_attribution: dailyUsage.length ? 'stored_grouped_metrics_partial' : 'not_available',
      render_measurements: days.filter((day) => day.coverage.recorded_render).length,
      render_measurements_unit: 'calendar_days',
      hourly_render_measurements: hourlySeries.filter((row) => row.coverage.recorded_render).length,
      hourly_application_measurements: hourlySeries.filter((row) => row.coverage.recorded_application).length,
      attribution_method: 'stored_daily_aggregate_feature_proxy',
      verified_source_costs_available: false,
    },
    notes: [
      'Daily usage comes from persisted aggregated monitor records, never a live full report.',
      'Recent Render daily totals are reconstructed from stored provider hourly measurements when they improve archived snapshots.',
      'Today and Yesterday hourly_series contain exactly 24 Cambodia hours when available; missing hours are null, not zero.',
      'Hourly API data uses persisted 15-minute backend snapshots and cannot be split reliably between Web and Admin.',
      'Older Render measurements require archived daily snapshots; missing hours are not inferred as zero.',
      'Web and Admin are API feature proxies, not verified traffic origin or bill attribution.',
      'Render bandwidth and observed application bytes are separate measurements and must not be added.',
      'Missing snapshots, incomplete monitored intervals, and unverified invoices remain unknown, never zero.',
    ],
  }
}

export async function getResourceCostOverview({ period = 'last7', from = null, to = null, now = new Date() } = {}, dependencies = {}) {
  const selection = selectedPeriod(period, now, from, to)
  if (dependencies.database) return readOverview(selection, dependencies, now)
  const key = `${period}:${selection.from_date}:${selection.through_date}:${selection.today}`
  const current = Date.now()
  const ttl = selection.dates.includes(selection.today) ? 2 * 60_000 : selection.through_date === shiftDay(selection.today, -1) ? 15 * 60_000 : 60 * 60_000
  const existing = cache.get(key)
  if (existing && existing.expires > current) return existing.pending
  const pending = readOverview(selection, {}, now)
  cache.set(key, { expires: current + ttl, pending })
  while (cache.size > 12) cache.delete(cache.keys().next().value)
  try {
    return await pending
  } catch (error) {
    if (cache.get(key)?.pending === pending) cache.delete(key)
    throw error
  }
}
