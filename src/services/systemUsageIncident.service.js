import { supabase } from '../config/supabase.js'
import { getSystemUsageAnomalySnapshot } from './systemUsageAnomaly.service.js'
import { setWorkKillSwitch } from './workKillSwitch.service.js'

const CHECK_MS = 15 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
const FULL_EVIDENCE_RETENTION_MS = 180 * DAY_MS
const SUMMARY_RETENTION_MS = 3 * 365 * DAY_MS
const REOPEN_WINDOW_MS = FULL_EVIDENCE_RETENTION_MS
const CLEANUP_MS = 24 * 60 * 60 * 1000
const CLEANUP_BATCH = 100
const AUTO_CONTAINMENT_MS = 10 * 60 * 1000
const AUTO_METHODS = new Set([
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
])
const AUTO_BYPASS_PREFIXES = [
  '/api/auth',
  '/api/admin/login-guard',
  '/api/admin/work',
  '/api/admin/system-control',
  '/api/purchase/aba/callback',
  '/api/telegram/webhook',
]

let timer = null
let cleanupTimer = null
let lastStatus = 'startup'
let lastSignature = ''
let activeIncidentId = null
let activeFingerprint = null
let activeProtection = null
let syncing = false

function clean(value, maxLength = 500) {
  return String(value || '').trim().slice(0, maxLength)
}

function safeNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(0, number) : 0
}

function normalizeSeverity(value) {
  const severity = clean(value, 20).toLowerCase()

  return [
    'info',
    'medium',
    'high',
    'critical',
  ].includes(severity)
    ? severity
    : 'medium'
}

function normalizePath(value) {
  const raw = clean(value, 500).split('?')[0] || '/'
  const path = raw.startsWith('/') ? raw : `/${raw}`

  return path.replace(/\/{2,}/g, '/')
}

function startsWithPrefix(path, prefix) {
  return path === prefix || path.startsWith(`${prefix}/`)
}

function isAutoBypassedPath(path) {
  return AUTO_BYPASS_PREFIXES.some((prefix) =>
    startsWithPrefix(path, prefix)
  )
}

function buildFingerprint(snapshot) {
  const driver = snapshot?.top_driver || {}

  return [
    clean(driver.feature || 'unknown', 120),
    clean(driver.source_route || 'UNKNOWN', 300),
    clean(driver.dependency || 'UNKNOWN', 120),
  ].join('|')
}

function protectionPlan(snapshot) {
  const severity = normalizeSeverity(snapshot?.severity)
  const classification = clean(
    snapshot?.classification || 'unknown',
    80
  ).toLowerCase()
  const driver = snapshot?.top_driver || {}
  const method = clean(
    driver.source_method || '',
    16
  ).toUpperCase()
  const path = normalizePath(driver.source_path || '/')

  if (severity !== 'critical') {
    return {
      eligible: false,
      reason: 'severity_below_critical',
    }
  }

  if (
    classification === 'background_egress' ||
    classification === 'background_job'
  ) {
    return {
      eligible: false,
      reason: 'background_requires_worker_control',
    }
  }

  if (!AUTO_METHODS.has(method)) {
    return {
      eligible: false,
      reason: 'unsupported_method',
    }
  }

  if (!path.startsWith('/api/')) {
    return {
      eligible: false,
      reason: 'non_api_target',
    }
  }

  if (isAutoBypassedPath(path)) {
    return {
      eligible: false,
      reason: 'protected_bypass_route',
    }
  }

  return {
    eligible: true,
    reason: 'critical_api_anomaly',
    source: 'ALL',
    method,
    path,
    duration_ms: AUTO_CONTAINMENT_MS,
  }
}

function buildEvidence(
  snapshot,
  protection = activeProtection
) {
  return {
    retention_tier: 'full',
    severity: normalizeSeverity(snapshot?.severity),
    classification:
      clean(
        snapshot?.classification || 'unknown',
        80
      ) || 'unknown',
    signals: Array.isArray(snapshot?.signals)
      ? snapshot.signals
      : [],
    current: snapshot?.current || null,
    baseline: snapshot?.baseline || null,
    thresholds: snapshot?.thresholds || null,
    top_driver: snapshot?.top_driver || null,
    protection:
      protection || {
        status: 'inactive',
        plan: protectionPlan(snapshot),
      },
  }
}

function compactTopDriver(driver) {
  if (!driver || typeof driver !== 'object') {
    return null
  }

  return {
    kind: driver.kind || null,
    feature: driver.feature || null,
    source_route: driver.source_route || null,
    source_method: driver.source_method || null,
    source_path: driver.source_path || null,
    dependency: driver.dependency || null,
    count: safeNumber(driver.count),
    bytes: safeNumber(driver.bytes),
    mb: safeNumber(driver.mb),
    errors: safeNumber(driver.errors),
    avg_ms: safeNumber(driver.avg_ms),
  }
}

function compactProtection(protection) {
  if (
    !protection ||
    typeof protection !== 'object'
  ) {
    return null
  }

  return {
    status: protection.status || 'inactive',
    kind: protection.kind || null,
    source: protection.source || null,
    method: protection.method || null,
    path: protection.path || null,
    activated_at: protection.activated_at || null,
    released_at: protection.released_at || null,
    release_reason:
      protection.release_reason || null,
    plan: protection.plan
      ? {
          eligible:
            protection.plan.eligible === true,
          reason:
            protection.plan.reason || null,
          method:
            protection.plan.method || null,
          path:
            protection.plan.path || null,
        }
      : null,
  }
}

function buildCompactEvidence(incident) {
  const evidence =
    incident?.evidence &&
    typeof incident.evidence === 'object'
      ? incident.evidence
      : {}

  return {
    retention_tier: 'summary',
    compacted_at: new Date().toISOString(),
    severity:
      evidence.severity ||
      incident.severity ||
      'medium',
    classification:
      evidence.classification || 'unknown',
    signals: Array.isArray(evidence.signals)
      ? evidence.signals.slice(0, 20)
      : [],
    top_driver: compactTopDriver(
      evidence.top_driver
    ),
    protection: compactProtection(
      evidence.protection
    ),
    advisor:
      evidence.advisor &&
      typeof evidence.advisor === 'object'
        ? evidence.advisor
        : null,
    resolution_summary: {
      feature: incident.feature || 'unknown',
      source_route:
        incident.source_route || 'UNKNOWN',
      dependency:
        incident.dependency || 'UNKNOWN',
      first_seen_at:
        incident.first_seen_at || null,
      last_seen_at:
        incident.last_seen_at || null,
      resolved_at:
        incident.resolved_at || null,
      recurrence_count: safeNumber(
        incident.recurrence_count
      ),
    },
  }
}

function snapshotSignature(snapshot) {
  const signals = Array.isArray(snapshot?.signals)
    ? [...snapshot.signals].sort().join(',')
    : ''

  return [
    clean(
      snapshot?.status || 'learning',
      40
    ).toLowerCase(),
    normalizeSeverity(snapshot?.severity),
    clean(
      snapshot?.classification || 'unknown',
      80
    ).toLowerCase(),
    signals,
  ].join('|')
}

async function findReusableIncident(fingerprint) {
  const { data, error } = await supabase
    .from('system_usage_incidents')
    .select('*')
    .eq('fingerprint', fingerprint)
    .order(
      'last_seen_at',
      { ascending: false }
    )
    .limit(1)
    .maybeSingle()

  if (error) throw error
  if (!data) return null

  if (data.status !== 'RESOLVED') {
    return data
  }

  const resolvedAt = new Date(
    data.resolved_at || 0
  ).getTime()

  if (!Number.isFinite(resolvedAt)) {
    return null
  }

  return Date.now() - resolvedAt <=
    REOPEN_WINDOW_MS
    ? data
    : null
}

async function openOrReopen(snapshot) {
  const fingerprint =
    buildFingerprint(snapshot)

  const now =
    new Date().toISOString()

  const reusable =
    await findReusableIncident(fingerprint)

  const severity =
    normalizeSeverity(snapshot?.severity)

  const evidence =
    buildEvidence(snapshot)

  if (reusable) {
    const recurrence =
      reusable.status === 'RESOLVED'
        ? Number(
            reusable.recurrence_count || 0
          ) + 1
        : Number(
            reusable.recurrence_count || 0
          )

    const { data, error } = await supabase
      .from('system_usage_incidents')
      .update({
        status: 'OPEN',
        severity,
        last_seen_at: now,
        resolved_at: null,
        delete_after: null,
        recurrence_count: recurrence,
        feature:
          snapshot?.top_driver?.feature ||
          'unknown',
        source_route:
          snapshot?.top_driver?.source_route ||
          'UNKNOWN',
        dependency:
          snapshot?.top_driver?.dependency ||
          'UNKNOWN',
        evidence,
      })
      .eq('id', reusable.id)
      .select('id')
      .single()

    if (error) throw error

    activeIncidentId = data.id
    activeFingerprint = fingerprint

    return data.id
  }

  const { data, error } = await supabase
    .from('system_usage_incidents')
    .insert({
      fingerprint,
      status: 'OPEN',
      severity,
      feature:
        snapshot?.top_driver?.feature ||
        'unknown',
      source_route:
        snapshot?.top_driver?.source_route ||
        'UNKNOWN',
      dependency:
        snapshot?.top_driver?.dependency ||
        'UNKNOWN',
      first_seen_at: now,
      last_seen_at: now,
      recurrence_count: 0,
      evidence,
    })
    .select('id')
    .single()

  if (error) throw error

  activeIncidentId = data.id
  activeFingerprint = fingerprint

  return data.id
}

async function activateProtection(snapshot) {
  const plan = protectionPlan(snapshot)

  if (!plan.eligible) {
    return {
      status: 'not_activated',
      plan,
    }
  }

  if (
    activeProtection?.status === 'active' &&
    activeProtection.method === plan.method &&
    activeProtection.path === plan.path &&
    new Date(
      activeProtection.expires_at || 0
    ).getTime() > Date.now()
  ) {
    return activeProtection
  }

  const expiresAt =
    new Date(
      Date.now() + AUTO_CONTAINMENT_MS
    ).toISOString()

  try {
    const record =
      await setWorkKillSwitch({
        targetType: 'api',
        source: 'ALL',
        method: plan.method,
        path: plan.path,
        enabled: true,
        mode: 'automatic',
        reason:
          'System Control critical usage anomaly containment',
        incidentId: activeIncidentId
          ? String(activeIncidentId)
          : null,
        expiresAt,
        actor: 'system:system-control',
      })

    activeProtection = {
      status: 'active',
      kind: 'kill_switch',
      switch_id: record?.id || null,
      incident_id: activeIncidentId,
      source: 'ALL',
      method: plan.method,
      path: plan.path,
      activated_at:
        new Date().toISOString(),
      expires_at:
        record?.expires_at ||
        expiresAt,
      plan,
    }

    return activeProtection
  } catch (error) {
    const failed = {
      status: 'failed',
      kind: 'kill_switch',
      incident_id: activeIncidentId,
      source: 'ALL',
      method: plan.method,
      path: plan.path,
      error: clean(
        error?.message || error,
        300
      ),
      plan,
    }

    console.error(
      'SYSTEM_USAGE_PROTECTION_ACTIVATE_ERROR:',
      failed.error
    )

    return failed
  }
}

async function releaseProtection(
  reason = 'usage_recovery'
) {
  if (
    activeProtection?.status !== 'active'
  ) {
    return activeProtection
  }

  const current = activeProtection

  try {
    const record =
      await setWorkKillSwitch({
        targetType: 'api',
        source:
          current.source || 'ALL',
        method: current.method,
        path: current.path,
        enabled: false,
        mode: 'automatic',
        reason:
          `System Control ${reason}`,
        incidentId:
          current.incident_id
            ? String(
                current.incident_id
              )
            : null,
        expiresAt: null,
        actor: 'system:system-control',
      })

    const released = {
      ...current,
      status: 'released',
      released_at:
        new Date().toISOString(),
      release_reason: reason,
      switch_id:
        record?.id ||
        current.switch_id ||
        null,
    }

    activeProtection = null

    return released
  } catch (error) {
    const failed = {
      ...current,
      status: 'release_failed',
      release_reason: reason,
      error: clean(
        error?.message || error,
        300
      ),
    }

    console.error(
      'SYSTEM_USAGE_PROTECTION_RELEASE_ERROR:',
      failed.error
    )

    return failed
  }
}

async function updateOpenEvidence(
  snapshot,
  protection
) {
  if (!activeIncidentId) return

  const { error } = await supabase
    .from('system_usage_incidents')
    .update({
      severity:
        normalizeSeverity(
          snapshot?.severity
        ),
      last_seen_at:
        new Date().toISOString(),
      evidence:
        buildEvidence(
          snapshot,
          protection
        ),
    })
    .eq('id', activeIncidentId)

  if (error) throw error
}

async function updateInvestigating(snapshot) {
  if (!activeIncidentId) return

  const protection =
    await releaseProtection(
      'anomaly_entered_recovery'
    )

  const { error } = await supabase
    .from('system_usage_incidents')
    .update({
      status: 'INVESTIGATING',
      severity:
        normalizeSeverity(
          snapshot?.severity
        ),
      last_seen_at:
        new Date().toISOString(),
      evidence:
        buildEvidence(
          snapshot,
          protection
        ),
    })
    .eq('id', activeIncidentId)

  if (error) throw error
}

async function resolveIncident(snapshot) {
  if (!activeIncidentId) return

  const incidentId =
    activeIncidentId

  const now = Date.now()

  const protection =
    await releaseProtection(
      'incident_resolved'
    )

  const { error } = await supabase
    .from('system_usage_incidents')
    .update({
      status: 'RESOLVED',
      severity:
        normalizeSeverity(
          snapshot?.severity
        ),
      last_seen_at:
        new Date(now).toISOString(),
      resolved_at:
        new Date(now).toISOString(),
      delete_after:
        new Date(
          now +
          FULL_EVIDENCE_RETENTION_MS
        ).toISOString(),
      evidence:
        buildEvidence(
          snapshot,
          protection
        ),
    })
    .eq('id', incidentId)

  if (error) throw error

  activeIncidentId = null
  activeFingerprint = null
}

async function syncTransition() {
  if (syncing) return

  const snapshot =
    getSystemUsageAnomalySnapshot()

  const status = clean(
    snapshot?.status || 'learning',
    40
  ).toLowerCase()

  const signature =
    snapshotSignature(snapshot)

  if (
    signature === lastSignature &&
    status === lastStatus
  ) {
    return
  }

  syncing = true
  const previous = lastStatus

  try {
    if (status === 'active') {
      await openOrReopen(snapshot)

      const protection =
        await activateProtection(snapshot)

      await updateOpenEvidence(
        snapshot,
        protection
      )
    } else if (
      status === 'recovery' &&
      ['active', 'startup'].includes(
        previous
      )
    ) {
      await updateInvestigating(snapshot)
    } else if (
      status === 'normal' &&
      ['active', 'recovery'].includes(
        previous
      )
    ) {
      await resolveIncident(snapshot)
    }

    lastStatus = status
    lastSignature = signature
  } catch (error) {
    console.error(
      'SYSTEM_USAGE_INCIDENT_TRANSITION_ERROR:',
      error?.message || error
    )
  } finally {
    syncing = false
  }
}

function summaryDeleteAt(incident) {
  const resolvedAt =
    new Date(
      incident.resolved_at ||
      incident.last_seen_at ||
      Date.now()
    ).getTime()

  const base =
    Number.isFinite(resolvedAt)
      ? resolvedAt
      : Date.now()

  return new Date(
    base + SUMMARY_RETENTION_MS
  ).toISOString()
}

async function compactResolvedIncident(
  incident
) {
  const { error } = await supabase
    .from('system_usage_incidents')
    .update({
      evidence:
        buildCompactEvidence(incident),
      delete_after:
        summaryDeleteAt(incident),
    })
    .eq('id', incident.id)
    .eq('status', 'RESOLVED')

  if (error) throw error
}

async function deleteResolvedIncident(id) {
  const { error } = await supabase
    .from('system_usage_incidents')
    .delete()
    .eq('id', id)
    .eq('status', 'RESOLVED')

  if (error) throw error
}

async function cleanupResolvedIncidents() {
  try {
    const nowMs = Date.now()
    const now =
      new Date(nowMs).toISOString()

    for (;;) {
      const { data, error } = await supabase
        .from('system_usage_incidents')
        .select(
          'id,status,severity,feature,source_route,dependency,first_seen_at,last_seen_at,resolved_at,delete_after,recurrence_count,evidence'
        )
        .eq('status', 'RESOLVED')
        .lte('delete_after', now)
        .order(
          'delete_after',
          { ascending: true }
        )
        .limit(CLEANUP_BATCH)

      if (error) throw error

      const rows =
        Array.isArray(data)
          ? data
          : []

      if (!rows.length) {
        break
      }

      for (const incident of rows) {
        const tier =
          incident?.evidence
            ?.retention_tier

        const finalDeleteAt =
          new Date(
            summaryDeleteAt(incident)
          ).getTime()

        if (
          tier === 'summary' &&
          Number.isFinite(
            finalDeleteAt
          ) &&
          finalDeleteAt <= nowMs
        ) {
          await deleteResolvedIncident(
            incident.id
          )
          continue
        }

        await compactResolvedIncident(
          incident
        )
      }

      if (rows.length < CLEANUP_BATCH) {
        break
      }
    }
  } catch (error) {
    console.error(
      'SYSTEM_USAGE_INCIDENT_CLEANUP_ERROR:',
      error?.message || error
    )
  }
}

export async function listSystemUsageIncidents(
  limit = 20
) {
  const safeLimit = Math.min(
    50,
    Math.max(
      1,
      Number(limit) || 20
    )
  )

  const { data, error } = await supabase
    .from('system_usage_incidents')
    .select(
      'id,status,severity,feature,source_route,dependency,first_seen_at,last_seen_at,resolved_at,recurrence_count,evidence'
    )
    .order(
      'last_seen_at',
      { ascending: false }
    )
    .limit(safeLimit)

  if (error) throw error

  return data || []
}

export function getSystemUsageIncidentRuntime() {
  return {
    active_incident_id:
      activeIncidentId,
    active_fingerprint:
      activeFingerprint,
    last_status: lastStatus,
    active_protection:
      activeProtection,
    retention: {
      unresolved_auto_delete: false,
      full_evidence_days: 180,
      summary_days: 1095,
      reopen_window_days: 180,
    },
  }
}

export function startSystemUsageIncidentService() {
  if (timer) return

  void syncTransition()
  void cleanupResolvedIncidents()

  timer = setInterval(
    () => void syncTransition(),
    CHECK_MS
  )

  cleanupTimer = setInterval(
    () =>
      void cleanupResolvedIncidents(),
    CLEANUP_MS
  )

  timer.unref?.()
  cleanupTimer.unref?.()
}
