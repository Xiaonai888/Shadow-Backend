function safeText(value, limit = 120) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, limit)
}

function maskIdentifiers(value) {
  return String(value || '')
    .replace(/(\/orders\/(?:status\/)?)[^/?\s]+/gi, '$1:id')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, ':id')
    .replace(/\b[a-f0-9]{24,}\b/gi, ':id')
    .replace(/\b[a-z0-9_-]{48,}\b/gi, ':id')
}

function safeRoute(value) {
  const text = safeText(value, 240)
  const index = text.indexOf('?')
  const route = maskIdentifiers(index < 0 ? text : text.slice(0, index))
  if (index < 0) return route.slice(0, 160)

  const query = text.slice(index + 1).split('&')
  const safeParams = []
  const allowed = new Set(['sort', 'cache', 'status'])
  for (const param of query) {
    const separator = param.indexOf('=')
    if (separator <= 0) continue
    const key = param.slice(0, separator).toLowerCase()
    const value = param.slice(separator + 1)
    if (!allowed.has(key) || !/^[a-z0-9_-]{1,32}$/i.test(value)) continue
    safeParams.push(`${key}=${value}`)
    if (safeParams.length >= 3) break
  }
  return `${route}${safeParams.length ? `?${safeParams.join('&')}` : ''}`.slice(0, 160)
}

function safeTarget(value) {
  return maskIdentifiers(safeText(value, 240).replace(/\?.*$/, '')).slice(0, 200)
}

function safeCount(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0
}

function safeDate(value) {
  const time = Date.parse(String(value || ''))
  return Number.isFinite(time) ? time : null
}

function boundedTime(value, fallback, min, max) {
  const time = safeDate(value)
  return new Date(time !== null && time >= min && time <= max ? time : fallback).toISOString()
}

function errorPriority(row) {
  if (row.http_status >= 500 || row.provider_http_status >= 500) return 3
  if (row.http_status === 0 && row.provider !== 'APPLICATION') return 2
  if (row.http_status === 429 || row.http_status === 408) return 1
  return 0
}

export function summarizeStoredErrorEvidence(
  snapshots = [],
  liveEvidence = [],
  { fromMs = 0, toMs = Date.now(), limit = 60 } = {}
) {
  const from = Number.isFinite(Number(fromMs)) ? Number(fromMs) : 0
  const to = Number.isFinite(Number(toMs)) ? Number(toMs) : Date.now()
  const take = Math.min(100, Math.max(1, Math.floor(Number(limit) || 60)))
  const windows = new Map()
  let windowsWithEvidence = 0
  let windowsWithoutEvidenceField = 0
  let snapshotsWithErrors = 0

  const add = (entry, source) => {
    if (!entry || typeof entry !== 'object') return
    const start = safeDate(entry.window_start)
    const end = safeDate(entry.window_end)
    if (start === null || end === null || end <= start || start >= to || end <= from) return
    const count = safeCount(entry.count)
    if (!count) return

    const row = {
      window_start: new Date(start).toISOString(),
      route: safeRoute(entry.route || 'UNKNOWN'),
      http_status: safeCount(entry.http_status),
      response_code: safeText(entry.response_code, 64) || null,
      root_cause_code: safeText(entry.root_cause_code, 64) || null,
      diagnostic_stage: safeText(entry.diagnostic_stage || 'unknown', 64),
      provider: safeText(entry.provider || 'APPLICATION', 80),
      provider_http_status: safeCount(entry.provider_http_status),
      error_class: safeText(entry.error_class || 'unknown', 64),
      target: safeTarget(entry.target || ''),
      count,
      first_seen_at: boundedTime(entry.first_seen_at, start, start, end),
      last_seen_at: boundedTime(entry.last_seen_at, end, start, end),
      evidence_source: source,
    }

    const key = [
      row.window_start,
      row.route,
      row.http_status,
      row.response_code,
      row.root_cause_code,
      row.diagnostic_stage,
      row.provider,
      row.provider_http_status,
      row.error_class,
      row.target,
    ].join('\u001f')
    const existing = windows.get(key)
    if (!existing) {
      windows.set(key, row)
      return
    }
    existing.count = Math.max(existing.count, row.count)
    if (row.first_seen_at < existing.first_seen_at) existing.first_seen_at = row.first_seen_at
    if (row.last_seen_at > existing.last_seen_at) existing.last_seen_at = row.last_seen_at
    if (source === 'stored_15m') existing.evidence_source = source
  }

  for (const snapshot of Array.isArray(snapshots) ? snapshots : []) {
    const payload = snapshot?.payload
    if (!Array.isArray(payload?.error_evidence)) {
      windowsWithoutEvidenceField++
      continue
    }
    windowsWithEvidence++
    if (payload.error_evidence.length) snapshotsWithErrors++
    for (const entry of payload.error_evidence) add(entry, 'stored_15m')
  }

  for (const entry of Array.isArray(liveEvidence) ? liveEvidence : []) add(entry, 'live_memory')

  const groups = new Map()
  for (const row of windows.values()) {
    const key = [
      row.route,
      row.http_status,
      row.response_code,
      row.root_cause_code,
      row.diagnostic_stage,
      row.provider,
      row.provider_http_status,
      row.error_class,
      row.target,
    ].join('\u001f')
    const current = groups.get(key)
    if (!current) {
      groups.set(key, { ...row, windows_seen: 1 })
      continue
    }
    current.count += row.count
    current.windows_seen++
    if (row.window_start < current.window_start) current.window_start = row.window_start
    if (row.first_seen_at < current.first_seen_at) current.first_seen_at = row.first_seen_at
    if (row.last_seen_at > current.last_seen_at) current.last_seen_at = row.last_seen_at
    if (row.evidence_source === 'stored_15m') current.evidence_source = 'stored_15m'
  }

  const ranked = [...groups.values()].sort((a, b) =>
    errorPriority(b) - errorPriority(a) ||
    b.count - a.count ||
    String(b.last_seen_at).localeCompare(String(a.last_seen_at))
  )

  return {
    rows: ranked.slice(0, take),
    coverage: {
      source: 'stored_15m_snapshots_plus_live_memory',
      stored_windows_with_error_field: windowsWithEvidence,
      stored_windows_without_error_field: windowsWithoutEvidenceField,
      stored_windows_with_errors: snapshotsWithErrors,
      distinct_error_groups: ranked.length,
      distinct_error_window_groups: windows.size,
      displayed_error_groups: Math.min(ranked.length, take),
      detail_capped: ranked.length > take,
      aggregated_across_windows: true,
      total_bounded_error_events: ranked.reduce((sum, row) => sum + row.count, 0),
      http_5xx_groups: ranked.filter((row) => row.http_status >= 500).length,
      unknown_diagnostic_stage_groups: ranked.filter((row) => row.diagnostic_stage === 'unknown').length,
      counts_are_bounded_diagnostics_not_total_event_errors: true,
    },
  }
}
