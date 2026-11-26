function num(value) {
  const n = Number(value)
  return Number.isFinite(n) ? Math.max(0, n) : 0
}

function suggestion(type, row, extra = {}) {
  return { type, status: 'REVIEW_REQUIRED', route: row.route, page: row.page, observations: num(row.observations), ...extra }
}

export function buildResourceOptimizationAdvisor(evidence = {}, { limit = 40 } = {}) {
  const findings = []
  for (const row of Array.isArray(evidence.rows) ? evidence.rows : []) {
    const repeat = num(row.repeated_signatures)
    const bytes = num(row.repeat_response_bytes)
    if (row.kind === 'HTTP' && num(row.cross_page_repeats) > 0) {
      findings.push(suggestion('SHARED_DATA_OPPORTUNITY', row, { repeated_signatures: repeat, cross_page_repeats: num(row.cross_page_repeats), observed_repeat_response_bytes: bytes, recommended_action: 'Review same-credential cross-page reads for shared client cache and in-flight deduplication.', safety_gate: 'Validate freshness, language, region, age, access and account boundaries before sharing.' }))
    } else if (row.kind === 'HTTP' && repeat > 0) {
      findings.push(suggestion('REPEATED_HTTP_SIGNATURE', row, { repeated_signatures: repeat, observed_repeat_response_bytes: bytes, observed_repeat_supabase_calls: num(row.repeat_supabase_calls), recommended_action: 'Review repeated reads, navigation effects and request deduplication.', safety_gate: 'Repeated request signatures do not prove equal responses or avoidable work.' }))
    }
    if (row.kind === 'SUPABASE' && repeat > 0) {
      findings.push(suggestion('REPEATED_SUPABASE_READ', row, { repeated_signatures: repeat, recommended_action: 'Review repeated REST reads within one request for safe request-local reuse.', safety_gate: 'Check intervening writes, transaction semantics and authorization before reuse.' }))
    }
  }
  findings.sort((a, b) => num(b.observed_repeat_response_bytes) - num(a.observed_repeat_response_bytes) || num(b.repeated_signatures) - num(a.repeated_signatures))
  const cap = Math.max(1, Math.min(80, Math.floor(num(limit) || 40)))
  return { version: 1, mode: 'review_only', auto_fix: false, savings_confirmed: false, measurement_note: 'Observed repeated traffic is not a savings estimate or provider-billed bandwidth. No response bodies compared. No cross-account cache safety inferred.', coverage: evidence.coverage || {}, detail_capped: Boolean(evidence.detail_capped) || findings.length > cap, total_findings_in_visible_evidence: findings.length, findings: findings.slice(0, cap) }
}
