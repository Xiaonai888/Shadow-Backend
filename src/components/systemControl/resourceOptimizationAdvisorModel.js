const labels = {
  SHARED_DATA_OPPORTUNITY: 'Shared Data Opportunity',
  REPEATED_HTTP_SIGNATURE: 'Repeated HTTP Request',
  REPEATED_SUPABASE_READ: 'Repeated Supabase Read',
}

export function formatOptimizationNumber(value) {
  return Number.isFinite(value) && value >= 0 ? Math.floor(value).toLocaleString('en-US') : '—'
}

export function formatOptimizationBytes(value) {
  if (!Number.isFinite(value) || value < 0) return '—'
  if (value < 1024) return `${Math.floor(value)} B`
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(2)} KB`
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(2)} MB`
  return `${(value / 1024 ** 3).toFixed(2)} GB`
}

export function normalizeResourceOptimization(payload) {
  const source = payload?.optimization ?? payload
  const evidence = source?.evidence
  const advisor = source?.advisor
  if (payload?.ok === false || evidence?.version !== 1 || advisor?.version !== 1 || !Array.isArray(advisor.findings)) {
    throw new Error('Optimization Advisor response is unavailable or unsupported.')
  }
  const historical = evidence.persistence === 'stored_15_minute_snapshot'
  const observed = historical ? Number(evidence.stored_windows || 0) > 0 : Number(evidence.windows_observed || 0) > 0
  const totals = observed && evidence.totals && typeof evidence.totals === 'object' ? evidence.totals : null
  const findings = advisor.findings.slice(0, 80).map(item => ({
    type: String(item?.type || ''),
    label: labels[item?.type] || 'Review Opportunity',
    route: String(item?.route || 'Unknown route').slice(0, 220),
    page: String(item?.page || 'Unattributed').slice(0, 180),
    observations: item?.observations,
    repeated: item?.repeated_signatures,
    crossPage: item?.cross_page_repeats,
    bytes: item?.observed_repeat_response_bytes,
    supabaseCalls: item?.observed_repeat_supabase_calls,
    action: String(item?.recommended_action || '').slice(0, 500),
    safety: String(item?.safety_gate || '').slice(0, 500),
  }))
  return {
    historical,
    status: !totals ? 'unavailable' : evidence.status === 'partial' ? 'partial' : 'observed',
    from: evidence.from,
    to: evidence.to,
    totals,
    findings,
    detailCapped: Boolean(evidence.detail_capped || advisor.detail_capped),
    note: String(advisor.measurement_note || '').slice(0, 700),
    coverage: evidence.coverage || {},
  }
}
