import { supabase } from '../config/supabase.js'
import { getResourceCostReport } from './resourceCostReportData.service.js'
import { refreshSystemUsageDailySummary } from './systemUsageDailySummaryRefresh.service.js'

const TABLE = 'resource_cost_daily_snapshots'
const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS
const CAMBODIA_OFFSET_MS = 7 * HOUR_MS
const FIRST_CAPTURE_HOUR = 7
const RETRY_HOUR = 13
const READ_CACHE_MS = 15 * 60 * 1000
const MIN_RETRY_MS = 6 * HOUR_MS
const BACKFILL_DAYS = 7
const BACKFILL_LIMIT = 2
const MAX_ATTEMPTS = 8

let cached = { date: '', until: 0, value: null }
let pending = null
let dailySummaryJob = Promise.resolve()
const summaryRefreshSlots = new Set()
const backfillSlots = new Set()

function shiftDay(date, offset) {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + offset * DAY_MS).toISOString().slice(0, 10)
}

function utcStart(date) {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) - CAMBODIA_OFFSET_MS).toISOString()
}

export function resourceCostYesterdayWindow(now = new Date()) {
  const timestamp = new Date(now).getTime()
  if (!Number.isFinite(timestamp)) throw new TypeError('Invalid snapshot time.')
  const cambodiaTime = new Date(timestamp + CAMBODIA_OFFSET_MS)
  const today = cambodiaTime.toISOString().slice(0, 10)
  const yesterday = shiftDay(today, -1)
  return {
    date: yesterday,
    today,
    from: utcStart(yesterday),
    to: utcStart(today),
    localHour: cambodiaTime.getUTCHours(),
  }
}

function captureSlot(window) {
  return `${window.today}:${window.localHour < RETRY_HOUR ? 'morning' : 'afternoon'}`
}

function queueDailySummaryRefresh(day, slot) {
  const key = `${slot}:${day}`
  if (summaryRefreshSlots.has(key)) return
  summaryRefreshSlots.add(key)
  dailySummaryJob = dailySummaryJob
    .then(() => refreshSystemUsageDailySummary({ day }))
    .then((result) => {
      if (result?.status === 'missing') {
        console.warn('SYSTEM_USAGE_DAILY_SUMMARY_MISSING:', {
          day,
          reason: 'No verified archive windows were found for this day.',
        })
      }
    })
    .catch((error) => {
      summaryRefreshSlots.delete(key)
      console.error('SYSTEM_USAGE_DAILY_SUMMARY_REFRESH_ERROR:', {
        day,
        reason: String(error?.message || error).slice(0, 240),
        code: String(error?.cause?.code || error?.code || 'UNKNOWN').slice(0, 48),
      })
    })
  while (summaryRefreshSlots.size > 24) summaryRefreshSlots.delete(summaryRefreshSlots.values().next().value)
}

function measuredBytes(value) {
  const number = Number(value)
  return value !== null && value !== undefined && Number.isFinite(number) && number >= 0 ? number : null
}

function providerMetric(report, provider, pattern) {
  const metrics = report?.totals?.provider_metrics || []
  const match = metrics.find((item) =>
    item.provider === provider && item.unit === 'bytes' && pattern.test(String(item.metric || '')) &&
    Number(item.samples) > 0 && item.value !== null && item.value !== undefined
  )
  return match ? measuredBytes(match.value) : null
}

export function buildResourceCostYesterdayPayload(report) {
  const render = report?.totals?.render || {}
  const hasRender = Number(render.observed_service_hours) > 0
  const renderTotal = hasRender ? measuredBytes(render.total_bytes) : null
  const serviceInitiated = hasRender ? measuredBytes(render.service_initiated_bytes) : null
  const supabaseEgress = providerMetric(report, 'supabase', /egress|bandwidth/i)
  const r2Storage = providerMetric(report, 'cloudflare_r2', /^storage\.total\.bytes$/i)
  const configured = Array.isArray(report?.sources?.render?.configured_service_ids)
    ? report.sources.render.configured_service_ids.length : 0
  const expected = configured > 0 ? 24 * configured : null
  const observed = Number(render.observed_service_hours) || 0
  const missingHours = Array.isArray(report?.sources?.render?.service_hour_diagnostics)
    ? report.sources.render.service_hour_diagnostics.reduce((sum, item) =>
      sum + (Array.isArray(item.missing_hour_utc) ? item.missing_hour_utc.length : 0), 0)
    : null
  const nominalCoverage = String(render.coverage || 'unknown')
  const completeHours = expected !== null && observed >= expected && missingHours === 0
  const coverage = nominalCoverage === 'complete' && completeHours ? 'complete'
    : hasRender ? 'partial' : 'missing'
  const status = coverage === 'complete' && supabaseEgress !== null && r2Storage !== null
    ? 'complete' : 'partial'

  return {
    status,
    payload: {
      render_total_bytes: renderTotal,
      service_initiated_bytes: serviceInitiated,
      supabase_egress_bytes: supabaseEgress,
      cloudflare_r2_storage_bytes: r2Storage,
      invoiced_cost_usd: measuredBytes(report?.totals?.invoiced_cost_usd),
      render_coverage: coverage,
      render_observed_service_hours: observed,
      render_expected_service_hours: expected,
      sources: {
        render: coverage,
        supabase: supabaseEgress === null ? 'missing' : 'recorded',
        cloudflare_r2: r2Storage === null ? 'missing' : 'recorded',
        invoiced_cost: report?.totals?.invoiced_cost_usd == null ? 'unavailable' : 'recorded',
      },
    },
  }
}

async function readRow(date) {
  const { data, error } = await supabase
    .from(TABLE)
    .select('snapshot_date,captured_at,status,attempt_count,payload')
    .eq('snapshot_date', date)
    .maybeSingle()
  if (error) throw error
  return data || null
}

function updateCache(date, value) {
  cached = { date, until: Date.now() + READ_CACHE_MS, value }
}

function eligible(previous, nowMs) {
  if (!previous) return true
  if (previous.status === 'complete' || Number(previous.attempt_count) >= MAX_ATTEMPTS) return false
  const priorMs = Date.parse(previous.captured_at || '')
  return !Number.isFinite(priorMs) || nowMs - priorMs >= MIN_RETRY_MS
}

function preserveUsefulData(previous, next) {
  const old = previous?.payload
  if (!old || typeof old !== 'object') return next
  const payload = { ...next.payload }
  const oldHours = measuredBytes(old.render_observed_service_hours) ?? 0
  const newHours = measuredBytes(payload.render_observed_service_hours) ?? 0
  if (old.render_total_bytes != null && (payload.render_total_bytes === null || oldHours > newHours)) {
    for (const key of ['render_total_bytes', 'service_initiated_bytes', 'render_coverage', 'render_observed_service_hours', 'render_expected_service_hours']) {
      payload[key] = old[key] ?? null
    }
    payload.render_coverage = 'partial'
  } else if (oldHours === newHours && payload.service_initiated_bytes === null && old.service_initiated_bytes != null) {
    payload.service_initiated_bytes = old.service_initiated_bytes
  }
  for (const key of ['supabase_egress_bytes', 'cloudflare_r2_storage_bytes', 'invoiced_cost_usd']) {
    if (payload[key] === null && measuredBytes(old[key]) !== null) payload[key] = old[key]
  }
  const renderComplete = payload.render_coverage === 'complete'
  payload.sources = {
    render: payload.render_coverage || 'missing',
    supabase: payload.supabase_egress_bytes === null ? 'missing' : 'recorded',
    cloudflare_r2: payload.cloudflare_r2_storage_bytes === null ? 'missing' : 'recorded',
    invoiced_cost: payload.invoiced_cost_usd === null ? 'unavailable' : 'recorded',
  }
  return {
    status: renderComplete && payload.supabase_egress_bytes !== null && payload.cloudflare_r2_storage_bytes !== null ? 'complete' : 'partial',
    payload,
  }
}

async function writeDay(date, now, previous = undefined) {
  const old = previous === undefined ? await readRow(date) : previous
  const timestamp = new Date(now).getTime()
  if (!eligible(old, timestamp)) return old
  const report = await getResourceCostReport({
    from: utcStart(date),
    to: utcStart(shiftDay(date, 1)),
    asOf: new Date(now),
    includeApplication: false,
  })
  const snapshot = preserveUsefulData(old, buildResourceCostYesterdayPayload(report))
  const { data, error } = await supabase.from(TABLE).upsert({
    snapshot_date: date,
    captured_at: new Date(now).toISOString(),
    status: snapshot.status,
    attempt_count: (Number(old?.attempt_count) || 0) + 1,
    payload: snapshot.payload,
  }, { onConflict: 'snapshot_date' }).select('snapshot_date,captured_at,status,attempt_count,payload').single()
  if (error) throw error
  updateCache(date, data)
  return data
}

async function backfillMissingDays(window, now) {
  const slot = captureSlot(window)
  if (backfillSlots.has(slot)) return
  backfillSlots.add(slot)
  while (backfillSlots.size > 6) backfillSlots.delete(backfillSlots.values().next().value)
  const firstDate = shiftDay(window.date, -(BACKFILL_DAYS - 1))
  const { data, error } = await supabase.from(TABLE)
    .select('snapshot_date,captured_at,status,attempt_count,payload')
    .gte('snapshot_date', firstDate)
    .lt('snapshot_date', window.date)
    .order('snapshot_date', { ascending: true })
    .limit(BACKFILL_DAYS)
  if (error) throw error
  if (!Array.isArray(data)) throw new Error('Daily snapshot backfill returned invalid rows.')
  const existing = new Map(data.map((row) => [row.snapshot_date, row]))
  const dates = []
  for (let date = firstDate; date < window.date; date = shiftDay(date, 1)) {
    if (eligible(existing.get(date), new Date(now).getTime())) dates.push(date)
  }
  dates.sort((a, b) => {
    const first = existing.get(a)
    const second = existing.get(b)
    return Number(Boolean(first)) - Number(Boolean(second)) || a.localeCompare(b)
  })
  for (const date of dates.slice(0, BACKFILL_LIMIT)) {
    try {
      await writeDay(date, now, existing.get(date))
    } catch (error) {
      console.error('RESOURCE_COST_BACKFILL_ERROR:', {
        day: date,
        reason: String(error?.message || error).slice(0, 240),
      })
    }
  }
  const { data: summaries, error: summaryError } = await supabase
    .from('system_usage_daily_summaries')
    .select('summary_date')
    .eq('source_kind', 'observed_aggregates')
    .gte('summary_date', firstDate)
    .lt('summary_date', window.date)
    .order('summary_date', { ascending: true })
    .limit(BACKFILL_DAYS)
  if (summaryError) {
    console.error('SYSTEM_USAGE_SUMMARY_BACKFILL_QUERY_ERROR:', String(summaryError.message || summaryError).slice(0, 240))
    return
  }
  if (!Array.isArray(summaries)) return
  const saved = new Set(summaries.map((item) => item.summary_date))
  const missing = []
  for (let date = firstDate; date < window.date; date = shiftDay(date, 1)) {
    if (!saved.has(date)) missing.push(date)
  }
  for (const date of missing.slice(0, BACKFILL_LIMIT)) queueDailySummaryRefresh(date, slot)
}

export async function getResourceCostYesterdaySnapshot(now = new Date()) {
  const { date } = resourceCostYesterdayWindow(now)
  if (cached.date === date && cached.until > Date.now()) return cached.value
  const value = await readRow(date)
  updateCache(date, value)
  return value
}

export async function captureResourceCostYesterdaySnapshot(now = new Date()) {
  const window = resourceCostYesterdayWindow(now)
  if (window.localHour < FIRST_CAPTURE_HOUR) return null
  const slot = captureSlot(window)
  queueDailySummaryRefresh(window.date, slot)
  if (pending?.date === window.date) return pending.promise

  const promise = (async () => {
    let saved
    let failure
    try {
      saved = await writeDay(window.date, now)
    } catch (error) {
      failure = error
    }
    try {
      await backfillMissingDays(window, now)
    } catch (error) {
      console.error('RESOURCE_COST_BACKFILL_QUERY_ERROR:', String(error?.message || error).slice(0, 240))
    }
    if (failure) throw failure
    return saved
  })()
  pending = { date: window.date, promise }
  try {
    return await promise
  } finally {
    if (pending?.promise === promise) pending = null
  }
}
