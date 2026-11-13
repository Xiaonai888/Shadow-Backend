export const RESOURCE_COST_PROVIDERS = Object.freeze(['render', 'supabase', 'cloudflare_r2'])
export const RESOURCE_COST_KINDS = Object.freeze(['interval', 'cumulative', 'gauge'])
export const RESOURCE_COST_UNITS = Object.freeze(['bytes', 'requests', 'objects', 'usd', 'gb_month'])
export const RESOURCE_COST_STATUSES = Object.freeze(['ok', 'partial', 'missing', 'error'])

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

export function resourceCostTimestamp(value) {
  const timestamp = value instanceof Date ? value.getTime() : new Date(value).getTime()
  if (!Number.isFinite(timestamp)) throw new TypeError('A valid timestamp is required.')
  return timestamp
}

export function resourceCostUtcHour(value) {
  return new Date(Math.floor(resourceCostTimestamp(value) / HOUR_MS) * HOUR_MS).toISOString()
}

export function resourceCostRange(from, to, maxDays = 93) {
  const start = resourceCostTimestamp(from)
  const end = resourceCostTimestamp(to)
  if (start >= end || end - start > maxDays * DAY_MS) {
    throw new RangeError('The requested reporting range is invalid or too large.')
  }
  return { from: new Date(start).toISOString(), to: new Date(end).toISOString() }
}

export function resourceCostNonnegativeInteger(value, name = 'value') {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer.`)
  }
  return value
}

export function resourceCostNonnegativeNumber(value, name = 'value') {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative finite number.`)
  }
  return value
}

export function resourceCostKey(value, name = 'key', maxLength = 80) {
  const key = String(value ?? '').trim().toLowerCase()
  if (!key || key.length > maxLength || !/^[a-z][a-z0-9_.:-]*$/.test(key)) {
    throw new TypeError(`${name} must be a stable non-personal identifier.`)
  }
  return key
}

export function resourceCostCumulativeDelta(previous, current) {
  if (!previous || !current || previous.kind !== 'cumulative' || current.kind !== 'cumulative') {
    return { delta: null, status: 'not_comparable' }
  }
  if (['provider', 'metric', 'scope', 'unit', 'period_start'].some((key) => previous[key] !== current[key])) {
    return { delta: null, status: 'not_comparable' }
  }
  const before = previous.value
  const after = current.value
  if (typeof before !== 'number' || !Number.isFinite(before) || before < 0 ||
      typeof after !== 'number' || !Number.isFinite(after) || after < 0) {
    return { delta: null, status: 'missing' }
  }
  if (resourceCostTimestamp(current.observed_hour) <= resourceCostTimestamp(previous.observed_hour)) {
    return { delta: null, status: 'out_of_order' }
  }
  if (after < before) return { delta: null, status: 'counter_reset' }
  return { delta: after - before, status: 'ok' }
}

export function resourceCostRenderReconciliation({
  providerBytes,
  httpPayloadBytes,
  externalRequestBytes,
  sameWindow = false,
  completeProviderWindow = false,
}) {
  if (providerBytes === null || providerBytes === undefined || !sameWindow || !completeProviderWindow) {
    return { status: 'not_comparable', provider_bytes: providerBytes ?? null, observed_bytes: null, gap_bytes_estimate: null, excess_observed_bytes: null }
  }
  const official = resourceCostNonnegativeInteger(providerBytes, 'providerBytes')
  const http = resourceCostNonnegativeInteger(httpPayloadBytes, 'httpPayloadBytes')
  const external = resourceCostNonnegativeInteger(externalRequestBytes, 'externalRequestBytes')
  const observed = http + external
  if (!Number.isSafeInteger(observed)) throw new RangeError('Application byte totals are too large.')
  return {
    status: 'estimated_application_attribution',
    provider_bytes: official,
    observed_bytes: observed,
    http_payload_bytes: http,
    external_request_bytes: external,
    gap_bytes_estimate: Math.max(0, official - observed),
    excess_observed_bytes: Math.max(0, observed - official),
  }
}
