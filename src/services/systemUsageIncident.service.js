import { supabase } from '../config/supabase.js'
import { getSystemUsageAnomalySnapshot } from './systemUsageAnomaly.service.js'

const CHECK_MS = 15 * 1000
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000
const CLEANUP_MS = 24 * 60 * 60 * 1000

let timer = null
let cleanupTimer = null
let lastStatus = null
let activeIncidentId = null
let activeFingerprint = null
let syncing = false

function clean(value, maxLength = 500) {
  return String(value || '').trim().slice(0, maxLength)
}

function buildFingerprint(snapshot) {
  const driver = snapshot?.top_driver || {}

  return [
    clean(driver.feature || 'unknown', 120),
    clean(driver.source_route || 'UNKNOWN', 300),
    clean(driver.dependency || 'UNKNOWN', 120),
  ].join('|')
}

function buildEvidence(snapshot) {
  return {
    signals: Array.isArray(snapshot?.signals) ? snapshot.signals : [],
    current: snapshot?.current || null,
    baseline: snapshot?.baseline || null,
    top_driver: snapshot?.top_driver || null,
  }
}

async function findReusableIncident(fingerprint) {
  const { data, error } = await supabase
    .from('system_usage_incidents')
    .select('*')
    .eq('fingerprint', fingerprint)
    .order('last_seen_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) throw error
  if (!data) return null

  if (data.status !== 'RESOLVED') return data

  const resolvedAt = new Date(data.resolved_at || 0).getTime()
  if (!Number.isFinite(resolvedAt)) return null

  return Date.now() - resolvedAt <= RETENTION_MS ? data : null
}

async function openOrReopen(snapshot) {
  const fingerprint = buildFingerprint(snapshot)
  const now = new Date().toISOString()
  const reusable = await findReusableIncident(fingerprint)
  const evidence = buildEvidence(snapshot)

  if (reusable) {
    const recurrence =
      reusable.status === 'RESOLVED'
        ? Number(reusable.recurrence_count || 0) + 1
        : Number(reusable.recurrence_count || 0)

    const { data, error } = await supabase
      .from('system_usage_incidents')
      .update({
        status: 'OPEN',
        last_seen_at: now,
        resolved_at: null,
        delete_after: null,
        recurrence_count: recurrence,
        feature: snapshot?.top_driver?.feature || 'unknown',
        source_route: snapshot?.top_driver?.source_route || 'UNKNOWN',
        dependency: snapshot?.top_driver?.dependency || 'UNKNOWN',
        evidence,
      })
      .eq('id', reusable.id)
      .select('id')
      .single()

    if (error) throw error

    activeIncidentId = data.id
    activeFingerprint = fingerprint
    return
  }

  const { data, error } = await supabase
    .from('system_usage_incidents')
    .insert({
      fingerprint,
      status: 'OPEN',
      severity: 'medium',
      feature: snapshot?.top_driver?.feature || 'unknown',
      source_route: snapshot?.top_driver?.source_route || 'UNKNOWN',
      dependency: snapshot?.top_driver?.dependency || 'UNKNOWN',
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
}

async function updateInvestigating(snapshot) {
  if (!activeIncidentId) return

  const { error } = await supabase
    .from('system_usage_incidents')
    .update({
      status: 'INVESTIGATING',
      last_seen_at: new Date().toISOString(),
      evidence: buildEvidence(snapshot),
    })
    .eq('id', activeIncidentId)

  if (error) throw error
}

async function resolveIncident(snapshot) {
  if (!activeIncidentId) return

  const now = Date.now()

  const { error } = await supabase
    .from('system_usage_incidents')
    .update({
      status: 'RESOLVED',
      last_seen_at: new Date(now).toISOString(),
      resolved_at: new Date(now).toISOString(),
      delete_after: new Date(now + RETENTION_MS).toISOString(),
      evidence: buildEvidence(snapshot),
    })
    .eq('id', activeIncidentId)

  if (error) throw error

  activeIncidentId = null
  activeFingerprint = null
}

async function syncTransition() {
  if (syncing) return

  const snapshot = getSystemUsageAnomalySnapshot()
  const status = clean(snapshot?.status || 'learning', 40).toLowerCase()

  if (lastStatus === null) {
    lastStatus = status
    return
  }

  if (status === lastStatus) return

  syncing = true
  const previous = lastStatus

  try {
    if (status === 'active') {
      await openOrReopen(snapshot)
    } else if (status === 'recovery' && previous === 'active') {
      await updateInvestigating(snapshot)
    } else if (
      status === 'normal' &&
      ['active', 'recovery'].includes(previous)
    ) {
      await resolveIncident(snapshot)
    }

    lastStatus = status
  } catch (error) {
    console.error(
      'SYSTEM_USAGE_INCIDENT_TRANSITION_ERROR:',
      error?.message || error
    )
  } finally {
    syncing = false
  }
}

async function cleanupResolvedIncidents() {
  try {
    const now = new Date().toISOString()

    const { error } = await supabase
      .from('system_usage_incidents')
      .delete()
      .eq('status', 'RESOLVED')
      .lte('delete_after', now)

    if (error) throw error
  } catch (error) {
    console.error(
      'SYSTEM_USAGE_INCIDENT_CLEANUP_ERROR:',
      error?.message || error
    )
  }
}

export async function listSystemUsageIncidents(limit = 20) {
  const safeLimit = Math.min(
    50,
    Math.max(1, Number(limit) || 20)
  )

  const { data, error } = await supabase
    .from('system_usage_incidents')
    .select(
      'id,status,severity,feature,source_route,dependency,first_seen_at,last_seen_at,resolved_at,recurrence_count,evidence'
    )
    .order('last_seen_at', { ascending: false })
    .limit(safeLimit)

  if (error) throw error
  return data || []
}

export function getSystemUsageIncidentRuntime() {
  return {
    active_incident_id: activeIncidentId,
    active_fingerprint: activeFingerprint,
    last_status: lastStatus,
  }
}

export function startSystemUsageIncidentService() {
  if (timer) return

  lastStatus = getSystemUsageAnomalySnapshot()?.status || 'learning'

  timer = setInterval(
    () => void syncTransition(),
    CHECK_MS
  )

  cleanupTimer = setInterval(
    () => void cleanupResolvedIncidents(),
    CLEANUP_MS
  )

  timer.unref?.()
  cleanupTimer.unref?.()
}
