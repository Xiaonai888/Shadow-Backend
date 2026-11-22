function safeText(value, limit = 120) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, limit)
}

function safeTarget(value) {
  return safeText(value, 200)
    .replace(/\?.*$/, '')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, ':id')
    .replace(/\b[a-z0-9_-]{48,}\b/gi, '[redacted]')
}

function safeCount(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0
}

function safeDate(value) {
  const time = Date.parse(String(value || ''))
  return Number.isFinite(time) ? time : null
}

export function summarizeStoredErrorEvidence(
  snapshots = [],
  liveEvidence = [],
  { fromMs = 0, toMs = Date.now(), limit = 60 } = {}
) {
  const from = Number.isFinite(Number(fromMs)) ? Number(fromMs) : 0
  const to = Number.isFinite(Number(toMs)) ? Number(toMs) : Date.now()
  const take = Math.min(100, Math.max(1, Math.floor(Number(limit) || 60)))
  const groups = new Map()
  let windowsWithEvidence = 0
  let windowsWithoutEvidenceField = 0
  let snapshotsWithErrors = 0

  const add = (entry, source) => {
    if (!entry || typeof entry !== 'object') return
    const start = safeDate(entry.window_start)
    const end = safeDate(entry.window_end)
    if (start === null || end === null || start >= to || end <= from) return
    const count = safeCount(entry.count)
    if (!count) return
    const row = {
      window_start: new Date(start).toISOString(),
      route: safeText(entry.route || 'UNKNOWN', 160),
      http_status: safeCount(entry.http_status),
      response_code: safeText(entry.response_code, 64) || null,
      root_cause_code: safeText(entry.root_cause_code, 64) || null,
      diagnostic_stage: safeText(entry.diagnostic_stage || 'unknown', 64),
      provider: safeText(entry.provider || 'APPLICATION', 80),
      provider_http_status: safeCount(entry.provider_http_status),
      error_class: safeText(entry.error_class || 'unknown', 64),
      target: safeTarget(entry.target || ''),
      count,
      last_seen_at: safeText(entry.last_seen_at, 40) || null,
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
    const existing = groups.get(key)
    if (!existing) {
      groups.set(key, row)
      return
    }
    if (row.count > existing.count) existing.count = row.count
    if (row.last_seen_at && (!existing.last_seen_at || row.last_seen_at > existing.last_seen_at)) {
      existing.last_seen_at = row.last_seen_at
    }
    if (source === 'stored_15m') existing.evidence_source = source
  }

  for (const window of snapshots) {
    const payload = window?.payload
    if (!Array.isArray(payload?.error_evidence)) {
      windowsWithoutEvidenceField++
      continue
    }
    windowsWithEvidence++
    if (payload.error_evidence.length) snapshotsWithErrors++
    for (const entry of payload.error_evidence) add(entry, 'stored_15m')
  }

  for (const entry of liveEvidence) add(entry, 'live_memory')

  const ranked = [...groups.values()].sort((a, b) =>
    b.count - a.count || String(b.last_seen_at || '').localeCompare(String(a.last_seen_at || ''))
  )

  return {
    rows: ranked.slice(0, take),
    coverage: {
      source: 'stored_15m_snapshots_plus_live_memory',
      stored_windows_with_error_field: windowsWithEvidence,
      stored_windows_without_error_field: windowsWithoutEvidenceField,
      stored_windows_with_errors: snapshotsWithErrors,
      distinct_error_groups: ranked.length,
      displayed_error_groups: Math.min(ranked.length, take),
      detail_capped: ranked.length > take,
      counts_are_bounded_diagnostics_not_total_event_errors: true,
    },
  }
}
