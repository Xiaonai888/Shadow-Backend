import {
  RESOURCE_COST_KINDS,
  RESOURCE_COST_PROVIDERS,
  RESOURCE_COST_STATUSES,
  RESOURCE_COST_UNITS,
  resourceCostKey,
  resourceCostNonnegativeNumber,
  resourceCostRange,
  resourceCostTimestamp,
  resourceCostUtcHour,
} from './resourceCostMath.service.js'

const TABLE = 'resource_cost_provider_observations'
const PAGE_SIZE = 500
const MAX_PAGE_SIZE = 1000

function accepted(value, choices, name) {
  if (!choices.includes(value)) throw new TypeError(`Unsupported ${name}.`)
  return value
}

function normalizeObservation(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('An observation object is required.')
  }
  const provider = accepted(input.provider, RESOURCE_COST_PROVIDERS, 'provider')
  const metric = resourceCostKey(input.metric, 'metric')
  const scope = resourceCostKey(input.scope || 'account', 'scope', 120)
  const kind = accepted(input.kind, RESOURCE_COST_KINDS, 'measurement kind')
  const unit = accepted(input.unit, RESOURCE_COST_UNITS, 'unit')
  const status = accepted(input.status || 'ok', RESOURCE_COST_STATUSES, 'status')
  const observedAt = new Date(resourceCostTimestamp(input.observedAt || new Date())).toISOString()
  const periodStart = new Date(resourceCostTimestamp(input.periodStart)).toISOString()
  const periodEnd = new Date(resourceCostTimestamp(input.periodEnd)).toISOString()
  if (periodEnd <= periodStart) throw new RangeError('Provider measurement period must have an end after its start.')
  const value = input.value === null || input.value === undefined ? null : resourceCostNonnegativeNumber(input.value)
  if (status === 'ok' && value === null) throw new TypeError('Successful observations must include a measured value.')
  if (['bytes', 'requests', 'objects'].includes(unit) && value !== null && !Number.isSafeInteger(value)) {
    throw new TypeError('Byte and count measurements must be safe integers.')
  }
  return {
    provider,
    metric,
    scope,
    observed_hour: resourceCostUtcHour(observedAt),
    observed_at: observedAt,
    period_start: periodStart,
    period_end: periodEnd,
    kind,
    unit,
    value,
    status,
  }
}

async function getClient() {
  const { supabase } = await import('../config/supabase.js')
  return supabase
}

export async function saveResourceCostProviderObservations(observations, client = null) {
  if (!Array.isArray(observations) || observations.length > 1000) {
    throw new RangeError('Provide at most 1000 provider observations per call.')
  }
  if (observations.length === 0) return { rows: 0 }
  const deduplicated = new Map()
  for (const raw of observations) {
    const row = normalizeObservation(raw)
    const key = `${row.provider}\u001f${row.metric}\u001f${row.scope}\u001f${row.observed_hour}`
    const previous = deduplicated.get(key)
    if (!previous || row.observed_at >= previous.observed_at) deduplicated.set(key, row)
  }
  const database = client || await getClient()
  const rows = [...deduplicated.values()]
  for (let start = 0; start < rows.length; start += PAGE_SIZE) {
    const { error } = await database.rpc('resource_cost_save_provider_observations', {
      p_rows: rows.slice(start, start + PAGE_SIZE),
    })
    if (error) throw error
  }
  return { rows: rows.length }
}

export async function readResourceCostProviderObservations({
  from,
  to,
  provider = null,
  offset = 0,
  limit = PAGE_SIZE,
} = {}, client = null) {
  const range = resourceCostRange(from, to)
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
    throw new RangeError('Invalid page parameters.')
  }
  if (provider !== null) accepted(provider, RESOURCE_COST_PROVIDERS, 'provider')
  const database = client || await getClient()
  let query = database.from(TABLE)
    .select('provider,metric,scope,observed_hour,observed_at,period_start,period_end,kind,unit,value,status')
    .gte('observed_at', range.from)
    .lt('observed_at', range.to)
    .order('observed_at', { ascending: true })
    .order('provider', { ascending: true })
    .order('metric', { ascending: true })
    .order('scope', { ascending: true })
    .range(offset, offset + limit)
  if (provider) query = query.eq('provider', provider)
  const { data, error } = await query
  if (error) throw error
  const raw = Array.isArray(data) ? data : []
  const hasMore = raw.length > limit
  return {
    range,
    rows: raw.slice(0, limit),
    has_more: hasMore,
    next_offset: hasMore ? offset + limit : null,
  }
}
