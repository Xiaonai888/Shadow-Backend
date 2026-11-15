import { supabase } from '../config/supabase.js'
import { getResourceCostReport } from './resourceCostReportData.service.js'

const TABLE = 'resource_cost_daily_snapshots'
const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS
const CAMBODIA_OFFSET_MS = 7 * HOUR_MS
const FIRST_CAPTURE_HOUR = 7
const RETRY_DELAY_MS = 6 * HOUR_MS
const READ_CACHE_MS = 15 * 60 * 1000

let cached = { date: '', until: 0, value: null }
let pending = null

export function resourceCostYesterdayWindow(now = new Date()) {
  const timestamp = new Date(now).getTime()
  if (!Number.isFinite(timestamp)) throw new TypeError('Invalid snapshot time.')
  const cambodiaTime = new Date(timestamp + CAMBODIA_OFFSET_MS)
  const today = cambodiaTime.toISOString().slice(0, 10)
  const yesterday = new Date(timestamp + CAMBODIA_OFFSET_MS - DAY_MS).toISOString().slice(0, 10)
  const start = Date.parse(`${yesterday}T00:00:00.000Z`) - CAMBODIA_OFFSET_MS
  return {
    date: yesterday,
    today,
    from: new Date(start).toISOString(),
    to: new Date(start + DAY_MS).toISOString(),
    localHour: cambodiaTime.getUTCHours(),
  }
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
  const coverage = String(render.coverage || 'unknown')
  const status = hasRender && coverage === 'complete' && supabaseEgress !== null && r2Storage !== null
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
      render_observed_service_hours: Number(render.observed_service_hours) || 0,
      render_expected_service_hours: render.expected_service_hours !== null && render.expected_service_hours !== undefined &&
        Number.isFinite(Number(render.expected_service_hours)) ? Number(render.expected_service_hours) : null,
      sources: {
        render: hasRender ? coverage : 'missing',
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
  if (pending?.date === window.date) return pending.promise

  const promise = (async () => {
    const previous = await readRow(window.date)
    if (previous?.status === 'complete' || Number(previous?.attempt_count) >= 2) {
      updateCache(window.date, previous)
      return previous
    }
    if (previous && new Date(now).getTime() - Date.parse(previous.captured_at) < RETRY_DELAY_MS) {
      updateCache(window.date, previous)
      return previous
    }

    const report = await getResourceCostReport({
      from: window.from,
      to: window.to,
      asOf: new Date(now),
      includeApplication: false,
    })
    const snapshot = buildResourceCostYesterdayPayload(report)
    const { data, error } = await supabase.from(TABLE).upsert({
      snapshot_date: window.date,
      captured_at: new Date(now).toISOString(),
      status: snapshot.status,
      attempt_count: previous ? Number(previous.attempt_count) + 1 : 1,
      payload: snapshot.payload,
    }, { onConflict: 'snapshot_date' }).select('snapshot_date,captured_at,status,attempt_count,payload').single()
    if (error) throw error
    updateCache(window.date, data)
    return data
  })()

  pending = { date: window.date, promise }
  try {
    return await promise
  } finally {
    if (pending?.promise === promise) pending = null
  }
}
