import { reloadActiveWorkKillSwitches } from './workKillSwitch.service.js'
import { publishSecurityEvent, reportGuardState } from './securityControlPlane.service.js'

const RETRY_MS = 30 * 1000
const REFRESH_MS = 60 * 1000
const MAX_ACTIVE_SWITCHES = 500
let verified = false
let loading = null
let retryAfter = 0
let refreshTimer = null
let consecutiveFailures = 0
let lastVerifiedAt = null

function safeDiagnosticText(value, maxLength = 320) {
  return String(value ?? '')
    .replace(/https?:\/\/[^\s]+/gi, '[URL_REDACTED]')
    .replace(/Bearer\s+[^\s]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(token|password|secret|authorization|api[_-]?key|service[_-]?role[_-]?key)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .slice(0, maxLength)
}

function bootstrapErrorDiagnostic(error, durationMs) {
  const statusValue = Number(error?.status ?? error?.statusCode ?? error?.cause?.status)
  const status = Number.isFinite(statusValue) && statusValue >= 100 ? statusValue : null
  const code = safeDiagnosticText(error?.code || error?.cause?.code || '', 64) || null
  const message = safeDiagnosticText(error?.message || 'Unknown bootstrap error')
  const details = safeDiagnosticText(error?.details || '', 400) || null
  const hint = safeDiagnosticText(error?.hint || '', 240) || null
  const cause = safeDiagnosticText(error?.cause?.message || '', 240) || null
  const signal = [code, message, details, cause].filter(Boolean).join(' ')
  let causeCategory = 'UNCLASSIFIED_UPSTREAM_ERROR'

  if (status === 521 || /\b(?:HTTP|status)\s*521\b/i.test(signal)) {
    causeCategory = 'SUPABASE_UPSTREAM_HTTP_521'
  } else if (code === '57014') {
    causeCategory = 'SUPABASE_QUERY_CANCELED_OR_TIMEOUT'
  } else if (code === '42P01') {
    causeCategory = 'WORK_KILL_SWITCHES_TABLE_MISSING'
  } else if (code === '42501' || status === 401 || status === 403) {
    causeCategory = 'SUPABASE_AUTH_OR_PERMISSION_DENIED'
  } else if (code === 'WORK_SWITCH_LIST_INVALID') {
    causeCategory = 'WORK_SWITCH_LIST_INVALID_OR_LIMIT_REACHED'
  } else if (status !== null && status >= 500) {
    causeCategory = 'SUPABASE_UPSTREAM_HTTP_5XX'
  } else if (/ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|fetch failed|network|timeout/i.test(signal)) {
    causeCategory = 'SUPABASE_NETWORK_OR_TIMEOUT'
  } else if (status !== null && status >= 400) {
    causeCategory = 'SUPABASE_HTTP_4XX'
  }

  return {
    source: 'supabase',
    operation: 'load_active_work_kill_switches',
    table: 'work_kill_switches',
    phase: lastVerifiedAt ? 'refresh' : 'first_verification',
    cause_category: causeCategory,
    http_status: status,
    http_status_text: safeDiagnosticText(error?.statusText || '', 120) || null,
    error_code: code,
    message,
    details,
    hint,
    nested_cause: cause,
    duration_ms: durationMs,
    consecutive_failures: consecutiveFailures,
    last_verified_at: lastVerifiedAt,
    retry_after_seconds: RETRY_MS / 1000,
  }
}

export function isKillSwitchBootstrapVerified() {
  return verified
}

export function ensureKillSwitchBootstrapVerified(forceRefresh = false) {
  if (loading || Date.now() < retryAfter || (verified && !forceRefresh)) return
  retryAfter = Date.now() + RETRY_MS
  const startedAt = Date.now()

  loading = reloadActiveWorkKillSwitches()
    .then((records) => {
      if (!Array.isArray(records) || records.length >= MAX_ACTIVE_SWITCHES) {
        const error = new Error('Kill Switch bootstrap returned an incomplete active switch list')
        error.code = 'WORK_SWITCH_LIST_INVALID'
        throw error
      }

      const recoveredFailures = consecutiveFailures
      verified = true
      consecutiveFailures = 0
      lastVerifiedAt = new Date().toISOString()

      if (recoveredFailures > 0) {
        console.info('WORK_KILL_SWITCH_BOOTSTRAP_RECOVERED', {
          source: 'supabase',
          operation: 'load_active_work_kill_switches',
          active_count: records.length,
          previous_failures: recoveredFailures,
          duration_ms: Date.now() - startedAt,
          verified_at: lastVerifiedAt,
        })
      }

      if (!refreshTimer) {
        refreshTimer = setInterval(() => {
          ensureKillSwitchBootstrapVerified(true)
        }, REFRESH_MS)
        refreshTimer.unref?.()
      }

      reportGuardState({
        guard: 'kill_switch',
        state: records.length > 0 ? 'defending' : 'monitoring',
        reason: 'Kill Switch active targets verified against persistent storage',
        details: { active_count: records.length },
        severity: 'info',
      })
    })
    .catch((error) => {
      verified = false
      consecutiveFailures += 1
      const diagnostic = bootstrapErrorDiagnostic(error, Date.now() - startedAt)
      console.error('WORK_KILL_SWITCH_BOOTSTRAP_DIAGNOSTIC', diagnostic)
      reportGuardState({
        guard: 'kill_switch',
        state: 'degraded',
        reason: 'Kill Switch storage unverified; API fail-closed',
        severity: 'critical',
      })
      publishSecurityEvent({
        source: 'kill_switch',
        target: 'control_plane',
        type: 'kill_switch_bootstrap_unverified',
        severity: 'critical',
        payload: {
          retry_seconds: RETRY_MS / 1000,
          cause_category: diagnostic.cause_category,
          error_code: diagnostic.error_code,
          http_status: diagnostic.http_status,
          consecutive_failures: consecutiveFailures,
        },
      })
    })
    .finally(() => {
      loading = null
    })
}
