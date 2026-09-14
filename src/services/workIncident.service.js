import { supabase } from '../config/supabase.js'

const RETENTION_DAYS = 90
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000

let cleanupTimer = null

function cleanText(value, maxLength = 500) {
  return String(value || '').trim().slice(0, maxLength)
}

function normalizeSource(value) {
  const source = cleanText(value, 20).toUpperCase()
  return ['WEB', 'ADMIN', 'BACKEND', 'UNKNOWN'].includes(source) ? source : 'UNKNOWN'
}

function normalizeMethod(value) {
  return cleanText(value, 16).toUpperCase() || 'UNKNOWN'
}

function normalizePath(value) {
  const path = cleanText(value, 500)
  return path.startsWith('/') ? path : `/${path}`
}

function fingerprintOf({ source, method, path }) {
  return `${normalizeSource(source)}|${normalizeMethod(method)}|${normalizePath(path)}`
}

function safeIso(value, fallback = new Date().toISOString()) {
  const date = new Date(value || fallback)
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString()
}

export async function recordWorkIncidentActive({
  source,
  method,
  path,
  peakRequestsPerMinute = 0,
  detectedAt,
  lastDetectedAt,
}) {
  try {
    const normalizedSource = normalizeSource(source)
    const normalizedMethod = normalizeMethod(method)
    const normalizedPath = normalizePath(path)
    const fingerprint = fingerprintOf({
      source: normalizedSource,
      method: normalizedMethod,
      path: normalizedPath,
    })

    const firstDetectedAt = safeIso(detectedAt)
    const latestDetectedAt = safeIso(lastDetectedAt, firstDetectedAt)
    const peak = Math.max(0, Math.round(Number(peakRequestsPerMinute) || 0))

    const { error } = await supabase.rpc('upsert_work_incident', {
      p_fingerprint: fingerprint,
      p_source: normalizedSource,
      p_method: normalizedMethod,
      p_path: normalizedPath,
      p_peak_requests_per_minute: peak,
      p_detected_at: firstDetectedAt,
      p_last_detected_at: latestDetectedAt,
    })

    if (error) throw error

    return true
  } catch (error) {
    console.error('WORK_INCIDENT_ACTIVE_SAVE_ERROR:', error?.message || error)
    return false
  }
}

export async function recordWorkIncidentResolved({
  source,
  method,
  path,
  resolvedAt,
  peakRequestsPerMinute = 0,
}) {
  try {
    const fingerprint = fingerprintOf({ source, method, path })
    const resolved = safeIso(resolvedAt)
    const peak = Math.max(0, Math.round(Number(peakRequestsPerMinute) || 0))

    const { error } = await supabase
      .from('work_incidents')
      .update({
        status: 'resolved',
        resolved_at: resolved,
        peak_requests_per_minute: peak,
        updated_at: resolved,
      })
      .eq('fingerprint', fingerprint)
      .eq('status', 'active')

    if (error) throw error

    return true
  } catch (error) {
    console.error('WORK_INCIDENT_RESOLVED_SAVE_ERROR:', error?.message || error)
    return false
  }
}

export async function cleanupResolvedWorkIncidents() {
  try {
    const cutoff = new Date(
      Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000
    ).toISOString()

    const { error } = await supabase
      .from('work_incidents')
      .delete()
      .eq('status', 'resolved')
      .lt('resolved_at', cutoff)

    if (error) throw error

    return true
  } catch (error) {
    console.error('WORK_INCIDENT_CLEANUP_ERROR:', error?.message || error)
    return false
  }
}

export function startWorkIncidentCleanup() {
  if (cleanupTimer) return cleanupTimer

  void cleanupResolvedWorkIncidents()

  cleanupTimer = setInterval(() => {
    void cleanupResolvedWorkIncidents()
  }, CLEANUP_INTERVAL_MS)

  cleanupTimer.unref?.()
  return cleanupTimer
}
