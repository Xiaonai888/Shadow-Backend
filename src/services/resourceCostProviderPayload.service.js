function count(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function emptySupabase(reason) {
  return {
    available: false,
    complete: false,
    reason,
    rows: 0,
    timestamp: null,
    total_requests: null,
    breakdown: null,
  }
}

export function parseSupabaseUsageCountsStrict(payload) {
  if (!payload || !Array.isArray(payload.result)) return emptySupabase('invalid_response')
  if (!payload.result.length) return emptySupabase('no_usage_rows')
  const rows = payload.result.filter((row) => row && typeof row === 'object' && Number.isFinite(Date.parse(row.timestamp || '')))
  if (!rows.length) return emptySupabase('invalid_timestamps')
  rows.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
  const latest = rows[0]
  const breakdown = {
    auth: count(latest.total_auth_requests),
    realtime: count(latest.total_realtime_requests),
    rest: count(latest.total_rest_requests),
    storage: count(latest.total_storage_requests),
  }
  const valid = Object.values(breakdown).filter((value) => value !== null)
  const complete = valid.length === 4
  return {
    available: valid.length > 0,
    complete,
    reason: complete ? null : 'incomplete_usage_fields',
    rows: payload.result.length,
    timestamp: latest.timestamp,
    total_requests: complete ? valid.reduce((sum, value) => sum + value, 0) : null,
    breakdown,
  }
}

function metricPart(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { payload_bytes: null, metadata_bytes: null, objects: null, complete: false }
  }
  const payload_bytes = count(raw.payloadSize ?? raw.payload_size)
  const metadata_bytes = count(raw.metadataSize ?? raw.metadata_size)
  const objects = count(raw.objects)
  return {
    payload_bytes,
    metadata_bytes,
    objects,
    complete: payload_bytes !== null && metadata_bytes !== null && objects !== null,
  }
}

function sumKnown(parts, field) {
  if (parts.some((part) => part[field] === null)) return null
  const sum = parts.reduce((total, part) => total + part[field], 0)
  return Number.isSafeInteger(sum) ? sum : null
}

function storageClass(raw) {
  const published = metricPart(raw?.published)
  const uploaded = metricPart(raw?.uploaded)
  const parts = [published, uploaded]
  const payload_bytes = sumKnown(parts, 'payload_bytes')
  const metadata_bytes = sumKnown(parts, 'metadata_bytes')
  const objects = sumKnown(parts, 'objects')
  const total_bytes = payload_bytes === null || metadata_bytes === null ? null : payload_bytes + metadata_bytes
  const complete = parts.every((part) => part.complete) && Number.isSafeInteger(total_bytes)
  return {
    published,
    uploaded,
    payload_bytes,
    metadata_bytes,
    objects,
    total_bytes: Number.isSafeInteger(total_bytes) ? total_bytes : null,
    total_mb: Number.isSafeInteger(total_bytes) ? Number((total_bytes / (1024 * 1024)).toFixed(4)) : null,
    complete,
  }
}

export function parseCloudflareR2StorageStrict(payload) {
  if (!payload || payload.success === false || !payload.result || typeof payload.result !== 'object' || Array.isArray(payload.result)) return null
  const result = payload.result
  if (!result.standard && !result.infrequentAccess && !result.infrequent_access) return null
  const standard = storageClass(result.standard)
  const infrequent_access = storageClass(result.infrequentAccess ?? result.infrequent_access)
  const payload_bytes = sumKnown([standard, infrequent_access], 'payload_bytes')
  const metadata_bytes = sumKnown([standard, infrequent_access], 'metadata_bytes')
  const objects = sumKnown([standard, infrequent_access], 'objects')
  const total_bytes = payload_bytes === null || metadata_bytes === null ? null : payload_bytes + metadata_bytes
  const complete = standard.complete && infrequent_access.complete && Number.isSafeInteger(total_bytes)
  return {
    scope: 'account',
    standard,
    infrequent_access,
    total: {
      payload_bytes,
      metadata_bytes,
      objects,
      total_bytes: Number.isSafeInteger(total_bytes) ? total_bytes : null,
      total_mb: Number.isSafeInteger(total_bytes) ? Number((total_bytes / (1024 * 1024)).toFixed(4)) : null,
    },
    complete,
  }
}

export function hasValidCloudflareR2Operations(payload) {
  const accounts = payload?.viewer?.accounts
  return Array.isArray(accounts) && accounts.length > 0 && accounts.every((account) => Array.isArray(account?.r2OperationsAdaptiveGroups))
}
