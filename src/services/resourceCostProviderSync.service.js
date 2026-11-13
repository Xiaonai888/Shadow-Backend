import { saveResourceCostProviderObservations } from './resourceCostProviderLedger.service.js'

const HOUR_MS = 60 * 60 * 1000
const OPERATION_FIELDS = [
  'requests',
  'success_requests',
  'user_error_requests',
  'internal_error_requests',
  'class_a_requests',
  'class_b_requests',
  'free_requests',
  'unclassified_requests',
]

function validCount(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

export function buildResourceCostProviderObservations(state, at = new Date()) {
  const time = at instanceof Date ? at.getTime() : new Date(at).getTime()
  if (!Number.isFinite(time)) throw new TypeError('A valid provider sync time is required.')
  const now = new Date(time).toISOString()
  const previousHour = new Date(time - HOUR_MS).toISOString()
  const calendarMonthStart = new Date(Date.UTC(new Date(time).getUTCFullYear(), new Date(time).getUTCMonth(), 1)).toISOString()
  const records = []

  function push(provider, metric, scope, kind, unit, value, periodStart, periodEnd, sourceStatus = 'ok') {
    const valid = validCount(value)
    const status = sourceStatus === 'ok' && valid ? 'ok'
      : sourceStatus === 'partial' && valid ? 'partial'
        : sourceStatus === 'error' ? 'error' : 'missing'
    records.push({
      provider,
      metric,
      scope,
      kind,
      unit,
      observedAt: now,
      periodStart,
      periodEnd,
      value: valid ? value : null,
      status,
    })
  }

  const sb = state?.supabase || {}
  const sbScope = 'project'
  const sbStatus = sb.status === 'ok' ? 'ok' : sb.status === 'error' ? 'error' : 'missing'
  push('supabase', 'api.requests.provider_window', sbScope, 'gauge', 'requests', sb.total_requests, previousHour, now, sbStatus)
  for (const field of ['auth', 'realtime', 'rest', 'storage']) {
    push('supabase', `api.${field}.provider_window`, sbScope, 'gauge', 'requests', sb.breakdown?.[field], previousHour, now, sbStatus)
  }

  const cf = state?.cloudflare_r2 || {}
  const storage = cf.storage?.total
  const storageStatus = storage ? 'ok' : cf.status === 'error' ? 'error' : 'missing'
  push('cloudflare_r2', 'storage.total.bytes', 'account', 'gauge', 'bytes', storage?.total_bytes, previousHour, now, storageStatus)
  push('cloudflare_r2', 'storage.objects', 'account', 'gauge', 'objects', storage?.objects, previousHour, now, storageStatus)
  push('cloudflare_r2', 'storage.standard.bytes', 'account', 'gauge', 'bytes', cf.storage?.standard?.total_bytes, previousHour, now, storageStatus)
  push('cloudflare_r2', 'storage.infrequent.bytes', 'account', 'gauge', 'bytes', cf.storage?.infrequent_access?.total_bytes, previousHour, now, storageStatus)

  const op = cf.operations
  const opStatus = !op ? cf.status === 'error' ? 'error' : 'missing'
    : op.groups >= 10000 ? 'partial' : 'ok'
  const opStart = op?.window_start && Number.isFinite(Date.parse(op.window_start)) ? op.window_start : calendarMonthStart
  const opEnd = op?.window_end && Number.isFinite(Date.parse(op.window_end)) ? op.window_end : now
  for (const field of OPERATION_FIELDS) {
    push('cloudflare_r2', `operations.${field}`, 'account', 'cumulative', 'requests', op?.[field], opStart, opEnd, opStatus)
  }

  return records
}

export async function persistResourceCostProviderObservations(state, at = new Date(), save = saveResourceCostProviderObservations) {
  const observations = buildResourceCostProviderObservations(state, at)
  return save(observations)
}
