import { resourceCostRange, resourceCostTimestamp } from './resourceCostMath.service.js'

const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000
const CAMBODIA_OFFSET_MS = 7 * HOUR_MS
const MAX_REPORT_DAYS = 93
const RENDER_FIELDS = ['total_bytes', 'http_response_bytes', 'service_initiated_bytes', 'websocket_response_bytes', 'private_link_bytes']
const UPLOAD_FIELDS = ['attempts', 'successes', 'failures', 'ingress_bytes', 'egress_bytes', 'object_bytes']

function natural(value) {
  const number = Number(value)
  return Number.isSafeInteger(number) && number >= 0 ? number : null
}

function dateKey(ms) {
  return new Date(ms + CAMBODIA_OFFSET_MS).toISOString().slice(0, 10)
}

function dateStart(key) {
  const ms = Date.parse(`${key}T00:00:00.000Z`)
  return Number.isFinite(ms) ? ms - CAMBODIA_OFFSET_MS : NaN
}

function calendarDays(start, end) {
  const days = []
  const first = Math.floor((start + CAMBODIA_OFFSET_MS) / DAY_MS) * DAY_MS - CAMBODIA_OFFSET_MS
  for (let time = first; time < end; time += DAY_MS) {
    days.push({
      date: dateKey(time),
      start: Math.max(start, time),
      end: Math.min(end, time + DAY_MS),
    })
  }
  return days
}

function newRender() {
  return {
    total_bytes: 0,
    http_response_bytes: null,
    service_initiated_bytes: null,
    websocket_response_bytes: null,
    private_link_bytes: null,
    observed_service_hours: 0,
    expected_service_hours: null,
    breakdown_service_hours: 0,
    missing_breakdown_service_hours: 0,
    breakdown_gap_bytes: 0,
    breakdown_excess_bytes: 0,
    coverage: 'unknown',
  }
}

function newUpload() {
  return {
    attempts: 0,
    successes: 0,
    failures: 0,
    ingress_bytes: 0,
    egress_bytes: 0,
    object_bytes: 0,
    by_route: [],
  }
}

function newDay(item) {
  return {
    date: item.date,
    period_start: new Date(item.start).toISOString(),
    period_end: new Date(item.end).toISOString(),
    render: newRender(),
    provider_metrics: [],
    upload_audit: newUpload(),
    application_attribution: [],
    warnings: [],
  }
}

function accumulate(target, source, fields) {
  for (const field of fields) {
    const value = natural(source[field])
    if (value === null) continue
    target[field] = (target[field] ?? 0) + value
    if (!Number.isSafeInteger(target[field])) throw new RangeError('A resource counter exceeded safe integer precision.')
  }
}

function inRange(time, from, to) {
  return Number.isFinite(time) && time >= from && time < to
}

function normalizeRender(rows, days, from, to, serviceIds, asOf) {
  const seen = new Set()
  const targets = new Map(days.map((day) => [day.date, day]))
  const observedServices = new Set(serviceIds)
  const hourly = new Map()

  for (const row of rows) {
    const hour = Date.parse(row.hour_start || '')
    const service = String(row.service_id || '').trim()
    if (!service || !inRange(hour, from, to) || hour % HOUR_MS !== 0) continue
    const total = natural(row.total_bytes)
    if (total === null) continue
    const key = `${service}\u001f${hour}`
    if (seen.has(key)) throw new Error('Duplicate official Render service-hour records.')
    seen.add(key)
    observedServices.add(service)
    const day = targets.get(dateKey(hour))
    if (!day) continue
    day.render.total_bytes += total
    day.render.observed_service_hours += 1
    if (!Number.isSafeInteger(day.render.total_bytes)) throw new RangeError('Render total exceeds safe integer precision.')
    if (row.breakdown_available === true && RENDER_FIELDS.slice(1).every((field) => natural(row[field]) !== null)) {
      accumulate(day.render, row, RENDER_FIELDS.slice(1))
      const sourceSum = RENDER_FIELDS.slice(1).reduce((sum, field) => sum + natural(row[field]), 0)
      day.render.breakdown_gap_bytes += Math.max(0, total - sourceSum)
      day.render.breakdown_excess_bytes += Math.max(0, sourceSum - total)
      day.render.breakdown_service_hours += 1
    } else {
      day.render.missing_breakdown_service_hours += 1
    }
    const current = hourly.get(day.date) || new Set()
    current.add(key)
    hourly.set(day.date, current)
  }

  const names = [...observedServices].sort()
  for (const day of days) {
    const start = Date.parse(day.period_start)
    const end = Math.min(Date.parse(day.period_end), Math.floor((asOf - 2 * HOUR_MS) / HOUR_MS) * HOUR_MS)
    const expectedHours = Math.max(0, Math.floor((end - start) / HOUR_MS))
    day.render.expected_service_hours = names.length ? expectedHours * names.length : null
    if (!names.length) {
      day.render.coverage = 'unknown_services'
    } else if (!expectedHours) {
      day.render.coverage = 'pending_provider_data'
    } else if (day.render.observed_service_hours < day.render.expected_service_hours) {
      day.render.coverage = day.render.observed_service_hours ? 'partial' : 'missing'
    } else {
      day.render.coverage = day.render.missing_breakdown_service_hours ? 'partial_breakdown' : 'complete'
    }
    if (day.render.breakdown_gap_bytes || day.render.breakdown_excess_bytes) {
      day.warnings.push('render_breakdown_discrepancy')
      if (day.render.coverage === 'complete') day.render.coverage = 'partial_breakdown'
    }
    if (day.render.coverage !== 'complete') day.warnings.push(`render_${day.render.coverage}`)
  }
  return names
}

function providerIdentity(row) {
  return [row.provider, row.metric, row.scope, row.unit, row.kind, row.period_start].join('\u001f')
}

function metricIdentity(row) {
  return [row.provider, row.metric, row.scope, row.unit, row.kind].join('\u001f')
}

function addMetric(day, row, value, aggregation, complete) {
  const key = metricIdentity(row)
  let metric = day.provider_metrics.find((item) => item.identity === key)
  if (!metric) {
    metric = {
      identity: key,
      provider: row.provider,
      metric: row.metric,
      scope: row.scope,
      unit: row.unit,
      kind: row.kind,
      aggregation,
      value: null,
      samples: 0,
      incomplete_samples: 0,
      observed_at: null,
    }
    day.provider_metrics.push(metric)
  }
  if (!complete || value === null) {
    metric.incomplete_samples += 1
    return
  }
  if (aggregation === 'latest') {
    if (!metric.observed_at || row.observed_at > metric.observed_at) {
      metric.value = value
      metric.observed_at = row.observed_at
    }
  } else {
    metric.value = (metric.value ?? 0) + value
    if (!Number.isFinite(metric.value)) throw new RangeError('Provider usage is outside numeric precision.')
  }
  metric.samples += 1
}

function normalizeProviderObservations(rows, days, from, to) {
  const targets = new Map(days.map((day) => [day.date, day]))
  const sorted = rows.filter((row) => row && row.provider !== 'render')
    .sort((a, b) => Date.parse(a.observed_at || '') - Date.parse(b.observed_at || ''))
  const previous = new Map()
  const observed = new Set()
  for (const row of sorted) {
    const at = Date.parse(row.observed_at || '')
    if (!Number.isFinite(at)) continue
    const id = providerIdentity(row)
    const identity = `${id}\u001f${row.observed_hour}`
    if (observed.has(identity)) throw new Error('Duplicate provider observation key in report data.')
    observed.add(identity)
    const kind = row.kind
    const statusOk = row.status === 'ok' && typeof row.value === 'number' && Number.isFinite(row.value) && row.value >= 0
    const prior = previous.get(id)
    if (kind === 'cumulative') previous.set(id, row)
    const intervalStart = kind === 'interval' ? Date.parse(row.period_start || '') : NaN
    const targetTime = kind === 'interval' ? intervalStart : at
    if (!inRange(targetTime, from, to)) continue
    const day = targets.get(dateKey(targetTime))
    if (!day) continue
    if (kind === 'cumulative') {
      const priorAt = prior ? Date.parse(prior.observed_at || '') : NaN
      const comparable = prior && prior.status === 'ok' && statusOk &&
        Number.isFinite(priorAt) && at > priorAt && at - priorAt <= 26 * HOUR_MS &&
        typeof prior.value === 'number' && row.value >= prior.value
      addMetric(day, row, comparable ? row.value - prior.value : null, 'delta', comparable)
    } else if (kind === 'interval') {
      const start = Date.parse(row.period_start || '')
      const end = Date.parse(row.period_end || '')
      const properPeriod = Number.isFinite(start) && Number.isFinite(end) &&
        end > start && start >= from && end <= to && dateKey(start) === dateKey(end - 1)
      addMetric(day, row, statusOk && properPeriod ? row.value : null, 'sum', statusOk && properPeriod)
    } else if (kind === 'gauge') {
      addMetric(day, row, statusOk ? row.value : null, 'latest', statusOk)
    }
  }
  for (const day of days) {
    day.provider_metrics.sort((a, b) => a.identity.localeCompare(b.identity))
    if (day.provider_metrics.some((row) => row.incomplete_samples > 0)) day.warnings.push('provider_metric_incomplete')
  }
}

function normalizeUploadAudit(rows, days, from, to) {
  const targets = new Map(days.map((day) => [day.date, day]))
  const seen = new Set()
  for (const row of rows) {
    const hour = Date.parse(row.hour_start || '')
    if (!inRange(hour, from, to)) continue
    const key = [row.hour_start, row.feature, row.route, row.upload_mode].join('\u001f')
    if (seen.has(key)) throw new Error('Duplicate upload audit hourly key.')
    seen.add(key)
    const day = targets.get(dateKey(hour))
    if (!day) continue
    const section = day.upload_audit
    accumulate(section, row, UPLOAD_FIELDS)
    const mode = String(row.upload_mode || '')
    const groupKey = [row.feature, row.route, mode].join('\u001f')
    let group = section.by_route.find((item) => item.identity === groupKey)
    if (!group) {
      group = { identity: groupKey, feature: row.feature, route: row.route, upload_mode: mode, ...newUpload() }
      delete group.by_route
      section.by_route.push(group)
    }
    accumulate(group, row, UPLOAD_FIELDS)
  }
  for (const day of days) {
    day.upload_audit.by_route.sort((a, b) => b.ingress_bytes - a.ingress_bytes)
  }
}

function normalizeApplicationAttribution(rows, days) {
  for (const day of days) {
    const start = Date.parse(day.period_start)
    const end = Date.parse(day.period_end)
    const sources = new Map()
    for (const row of rows) {
      const at = Date.parse(row.hour_start || row.started_at || '')
      if (!inRange(at, start, end)) continue
      const feature = String(row.feature || 'unknown')
      const dependency = String(row.dependency || 'UNKNOWN')
      const kind = String(row.kind || 'unknown')
      const key = [feature, dependency, kind].join('\u001f')
      const current = sources.get(key) || { feature, dependency, kind, observed_bytes: 0, observed_events: 0 }
      current.observed_bytes += natural(row.bytes) ?? 0
      current.observed_events += natural(row.count) ?? 0
      sources.set(key, current)
    }
    day.application_attribution = [...sources.values()].sort((a, b) => b.observed_bytes - a.observed_bytes)
  }
}

export function buildResourceCostSummary({
  from,
  to,
  asOf = new Date(),
  serviceIds = [],
  renderRows = [],
  providerRows = [],
  uploadRows = [],
  applicationRows = [],
} = {}) {
  const range = resourceCostRange(from, to, MAX_REPORT_DAYS)
  const start = resourceCostTimestamp(range.from)
  const end = resourceCostTimestamp(range.to)
  const days = calendarDays(start, end).map(newDay)
  const configured = Array.isArray(serviceIds) ? serviceIds.filter((value) => typeof value === 'string' && value.trim()) : []
  const names = normalizeRender(renderRows, days, start, end, configured, resourceCostTimestamp(asOf))
  normalizeProviderObservations(providerRows, days, start, end)
  normalizeUploadAudit(uploadRows, days, start, end)
  normalizeApplicationAttribution(applicationRows, days)
  const render = newRender()
  const uploads = newUpload()
  const metrics = new Map()
  for (const day of days) {
    render.total_bytes += day.render.total_bytes
    render.observed_service_hours += day.render.observed_service_hours
    render.breakdown_service_hours += day.render.breakdown_service_hours
    render.missing_breakdown_service_hours += day.render.missing_breakdown_service_hours
    render.breakdown_gap_bytes += day.render.breakdown_gap_bytes
    render.breakdown_excess_bytes += day.render.breakdown_excess_bytes
    if (day.render.expected_service_hours !== null) render.expected_service_hours = (render.expected_service_hours ?? 0) + day.render.expected_service_hours
    for (const field of RENDER_FIELDS.slice(1)) {
      if (day.render[field] !== null) render[field] = (render[field] ?? 0) + day.render[field]
    }
    accumulate(uploads, day.upload_audit, UPLOAD_FIELDS)
    for (const metric of day.provider_metrics) {
      const current = metrics.get(metric.identity)
      if (!current) {
        metrics.set(metric.identity, { ...metric })
      } else {
        current.samples += metric.samples
        current.incomplete_samples += metric.incomplete_samples
        if (metric.aggregation === 'latest') {
          if (metric.observed_at && (!current.observed_at || metric.observed_at >= current.observed_at)) {
            current.value = metric.value
            current.observed_at = metric.observed_at
          }
        } else {
          if (metric.value !== null) current.value = (current.value ?? 0) + metric.value
        }
      }
    }
  }
  const completeDays = days.filter((day) => day.render.coverage === 'complete').length
  render.coverage = !names.length ? 'unknown_services' : completeDays === days.length ? 'complete' : 'partial'
  return {
    period: { ...range, timezone: 'Asia/Phnom_Penh', days: days.length },
    generated_at: new Date().toISOString(),
    accuracy: {
      render_source: 'render_bandwidth_hourly',
      provider_source: 'resource_cost_provider_observations',
      upload_source: 'resource_cost_upload_hourly',
      independent_provider_bytes_must_not_be_summed: true,
      application_bytes_are_partial_attribution: true,
      invoiced_cost_available: false,
      upload_counters_are_not_provider_billing: true,
    },
    service_ids: names,
    totals: { render, provider_metrics: [...metrics.values()].sort((a, b) => a.identity.localeCompare(b.identity)), upload_audit: uploads, invoiced_cost_usd: null },
    days,
  }
}

export function resourceCostCalendarPeriod(date, mode = 'day') {
  const time = resourceCostTimestamp(date)
  const local = new Date(time + CAMBODIA_OFFSET_MS)
  const today = local.toISOString().slice(0, 10)
  if (mode === 'day') return { from: new Date(dateStart(today)).toISOString(), to: new Date(dateStart(today) + DAY_MS).toISOString() }
  if (mode === 'week') {
    const offsetDays = (local.getUTCDay() + 6) % 7
    const start = dateStart(today) - offsetDays * DAY_MS
    return { from: new Date(start).toISOString(), to: new Date(start + 7 * DAY_MS).toISOString() }
  }
  if (mode === 'month') {
    const year = local.getUTCFullYear()
    const month = local.getUTCMonth()
    return {
      from: new Date(Date.UTC(year, month, 1) - CAMBODIA_OFFSET_MS).toISOString(),
      to: new Date(Date.UTC(year, month + 1, 1) - CAMBODIA_OFFSET_MS).toISOString(),
    }
  }
  throw new TypeError('Unsupported calendar period.')
}
