import { reloadActiveWorkKillSwitches } from './workKillSwitch.service.js'
import { publishSecurityEvent, reportGuardState } from './securityControlPlane.service.js'

const RETRY_MS = 30 * 1000
const REFRESH_MS = 60 * 1000
const MAX_ACTIVE_SWITCHES = 500
let verified = false
let loading = null
let retryAfter = 0
let refreshTimer = null

export function isKillSwitchBootstrapVerified() {
  return verified
}

export function ensureKillSwitchBootstrapVerified(forceRefresh = false) {
  if (loading || Date.now() < retryAfter || (verified && !forceRefresh)) return
  retryAfter = Date.now() + RETRY_MS
  loading = reloadActiveWorkKillSwitches()
    .then((records) => {
      if (!Array.isArray(records) || records.length >= MAX_ACTIVE_SWITCHES) {
        throw new Error('Kill Switch bootstrap returned an incomplete active switch list')
      }
      verified = true
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
      console.error('WORK_KILL_SWITCH_BOOTSTRAP_RETRY_ERROR:', error?.message || error)
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
        payload: { retry_seconds: RETRY_MS / 1000 },
      })
    })
    .finally(() => {
      loading = null
    })
}
