import { supabase } from '../config/supabase.js'
import {
  publishSecurityEvent,
  reportGuardState,
} from './securityControlPlane.service.js'

const ACTIVE_SWITCH_LIMIT = 500
const USAGE_FLUSH_INTERVAL_MS = 60 * 1000
const EXPIRY_CHECK_INTERVAL_MS = 30 * 1000
const BLOCK_EVENT_THROTTLE_MS = 60 * 1000

const activeSwitches = new Map()
const pendingUsage = new Map()
const lastBlockedEventAt = new Map()

let usageTimer = null
let expiryTimer = null
let started = false
let lastReportedState = ''
let lastReportedCount = -1

function cleanText(value, maxLength = 500) {
  return String(value || '').trim().slice(0, maxLength)
}

function normalizeTargetType(value) {
  const targetType = cleanText(value, 20).toLowerCase()
  return ['api', 'page'].includes(targetType) ? targetType : ''
}

function normalizeSource(value) {
  const source = cleanText(value, 20).toUpperCase()
  return ['WEB', 'ADMIN', 'BACKEND', 'ALL'].includes(source) ? source : ''
}

function normalizeMethod(value) {
  const method = cleanText(value, 16).toUpperCase()
  return method || null
}

function normalizePath(value) {
  const raw = cleanText(value, 500).split('?')[0] || '/'
  const path = raw.startsWith('/') ? raw : `/${raw}`

  return path.replace(/\/{2,}/g, '/')
}

function normalizeMode(value) {
  const mode = cleanText(value, 20).toLowerCase()
  return ['manual', 'automatic'].includes(mode) ? mode : 'manual'
}

function safeIso(value) {
  if (!value) return null

  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function switchFingerprint({ targetType, source, method, path }) {
  return [
    normalizeTargetType(targetType),
    normalizeSource(source),
    normalizeTargetType(targetType) === 'api'
      ? normalizeMethod(method)
      : 'PAGE',
    normalizePath(path),
  ].join('|')
}

function isExpired(record, now = Date.now()) {
  if (!record?.expires_at) return false

  const expiresAt = new Date(record.expires_at).getTime()
  return Number.isFinite(expiresAt) && expiresAt <= now
}

function pathMatches(patternValue, pathValue) {
  const pattern = normalizePath(patternValue)
  const path = normalizePath(pathValue)

  if (pattern === path) return true

  const patternParts = pattern.split('/').filter(Boolean)
  const pathParts = path.split('/').filter(Boolean)

  if (patternParts.length !== pathParts.length) return false

  return patternParts.every((part, index) => {
    if (part === ':id') return Boolean(pathParts[index])
    return part === pathParts[index]
  })
}

function reportKillSwitchState(
  reason,
  severity = 'info',
  force = false,
  overrideState = ''
) {
  const count = activeSwitches.size
  const state = overrideState || (count > 0 ? 'defending' : 'sleeping')

  if (
    !force
    && state === lastReportedState
    && count === lastReportedCount
  ) {
    return
  }

  lastReportedState = state
  lastReportedCount = count

  reportGuardState({
    guard: 'kill_switch',
    state,
    reason,
    details: {
      active_count: count,
      pending_usage_count: pendingUsage.size,
    },
    severity,
  })
}

function publishKillSwitchEvent(
  type,
  severity,
  record = null,
  extra = {}
) {
  publishSecurityEvent({
    source: 'kill_switch',
    target: 'control_plane',
    type,
    severity,
    payload: {
      id: record?.id || null,
      target_type: record?.target_type || null,
      source: record?.source || null,
      method: record?.method || null,
      path: record?.path || null,
      mode: record?.mode || null,
      reason: record?.reason || null,
      expires_at: record?.expires_at || null,
      ...extra,
    },
  })
}

function updateCache(record) {
  if (!record?.id) return

  if (record.enabled && !isExpired(record)) {
    activeSwitches.set(record.id, record)
  } else {
    activeSwitches.delete(record.id)
    pendingUsage.delete(record.id)
    lastBlockedEventAt.delete(record.id)
  }
}

async function disableExpiredRecord(record) {
  if (!record?.id) return

  activeSwitches.delete(record.id)
  pendingUsage.delete(record.id)
  lastBlockedEventAt.delete(record.id)

  try {
    const { data, error } = await supabase.rpc('set_work_kill_switch', {
      p_target_type: record.target_type,
      p_source: record.source,
      p_method: record.method,
      p_path: record.path,
      p_enabled: false,
      p_mode: record.mode || 'manual',
      p_reason: record.reason || null,
      p_incident_id: record.incident_id || null,
      p_expires_at: null,
      p_actor: 'system:expiry',
    })

    if (error) throw error

    const nextRecord = Array.isArray(data) ? data[0] : data

    if (nextRecord?.id) {
      updateCache(nextRecord)
    }

    publishKillSwitchEvent(
      'kill_switch_expired',
      'info',
      record
    )

    reportKillSwitchState(
      activeSwitches.size > 0
        ? 'Kill Switch target expired; other defenses remain active'
        : 'Kill Switch sleeping; no active targets',
      'info',
      true
    )
  } catch (error) {
    reportKillSwitchState(
      'Kill Switch expiry persistence failed',
      'high',
      true,
      'degraded'
    )

    publishKillSwitchEvent(
      'kill_switch_expiry_failed',
      'high',
      record,
      {
        error: cleanText(error?.message || error, 300),
      }
    )

    console.error(
      'WORK_KILL_SWITCH_EXPIRE_ERROR:',
      error?.message || error
    )
  }
}

export async function reloadActiveWorkKillSwitches() {
  const { data, error } = await supabase
    .from('work_kill_switches')
    .select(
      'id,fingerprint,target_type,source,method,path,enabled,mode,reason,incident_id,activated_at,deactivated_at,expires_at,activation_count,blocked_requests,last_triggered_at,created_by,updated_by,created_at,updated_at'
    )
    .eq('enabled', true)
    .order('updated_at', { ascending: false })
    .limit(ACTIVE_SWITCH_LIMIT)

  if (error) throw error

  const next = new Map()
  const now = Date.now()

  for (const record of Array.isArray(data) ? data : []) {
    if (!record?.id) continue

    if (isExpired(record, now)) {
      void disableExpiredRecord(record)
      continue
    }

    next.set(record.id, record)
  }

  activeSwitches.clear()

  for (const [id, record] of next.entries()) {
    activeSwitches.set(id, record)
  }

  for (const id of [...lastBlockedEventAt.keys()]) {
    if (!activeSwitches.has(id)) {
      lastBlockedEventAt.delete(id)
    }
  }

  if (next.size >= ACTIVE_SWITCH_LIMIT) {
    console.warn(
      `WORK_KILL_SWITCH_ACTIVE_LIMIT_REACHED: ${ACTIVE_SWITCH_LIMIT}`
    )
  }

  reportKillSwitchState(
    next.size > 0
      ? 'Kill Switch active targets loaded'
      : 'Kill Switch sleeping; no active targets',
    'info',
    true
  )

  return [...activeSwitches.values()]
}

export async function setWorkKillSwitch({
  targetType,
  source,
  method = null,
  path,
  enabled,
  mode = 'manual',
  reason = '',
  incidentId = null,
  expiresAt = null,
  actor = '',
}) {
  const safeTargetType = normalizeTargetType(targetType)
  const safeSource = normalizeSource(source)
  const safeMethod = safeTargetType === 'api'
    ? normalizeMethod(method)
    : null
  const safePath = normalizePath(path)
  const safeMode = normalizeMode(mode)
  const safeExpiresAt = enabled ? safeIso(expiresAt) : null
  const safeReason = cleanText(reason, 1000) || null
  const safeActor = cleanText(actor, 200) || null

  if (!safeTargetType) {
    throw new Error('Invalid Kill Switch target type')
  }

  if (!safeSource) {
    throw new Error('Invalid Kill Switch source')
  }

  if (safeTargetType === 'api' && !safeMethod) {
    throw new Error('API Kill Switch requires method')
  }

  if (!safePath.startsWith('/')) {
    throw new Error('Invalid Kill Switch path')
  }

  const { data, error } = await supabase.rpc('set_work_kill_switch', {
    p_target_type: safeTargetType,
    p_source: safeSource,
    p_method: safeMethod,
    p_path: safePath,
    p_enabled: Boolean(enabled),
    p_mode: safeMode,
    p_reason: safeReason,
    p_incident_id: incidentId || null,
    p_expires_at: safeExpiresAt,
    p_actor: safeActor,
  })

  if (error) throw error

  const record = Array.isArray(data) ? data[0] : data

  if (!record?.id) {
    throw new Error('Kill Switch save returned no record')
  }

  const previouslyActive = activeSwitches.has(record.id)

  updateCache(record)

  if (record.enabled && !previouslyActive) {
    publishKillSwitchEvent(
      'kill_switch_activated',
      record.mode === 'automatic' ? 'high' : 'medium',
      record
    )
  } else if (!record.enabled && previouslyActive) {
    publishKillSwitchEvent(
      'kill_switch_released',
      'info',
      record
    )
  }

  reportKillSwitchState(
    activeSwitches.size > 0
      ? 'Kill Switch has active protection targets'
      : 'Kill Switch sleeping; no active targets',
    record.enabled ? 'medium' : 'info',
    true
  )

  return record
}

export function findActiveWorkKillSwitch({
  targetType,
  source,
  method = null,
  path,
}) {
  const safeTargetType = normalizeTargetType(targetType)
  const safeSource = normalizeSource(source)
  const safeMethod = normalizeMethod(method)
  const safePath = normalizePath(path)
  const now = Date.now()

  if (!safeTargetType || !safeSource) return null

  for (const record of activeSwitches.values()) {
    if (isExpired(record, now)) {
      void disableExpiredRecord(record)
      continue
    }

    if (record.target_type !== safeTargetType) continue
    if (record.source !== 'ALL' && record.source !== safeSource) continue

    if (
      safeTargetType === 'api'
      && normalizeMethod(record.method) !== safeMethod
    ) {
      continue
    }

    if (!pathMatches(record.path, safePath)) continue

    return record
  }

  return null
}

export function recordWorkKillSwitchBlocked(record) {
  if (!record?.id) return

  const current = pendingUsage.get(record.id) || {
    count: 0,
    lastTriggeredAt: null,
  }

  current.count += 1
  current.lastTriggeredAt = new Date().toISOString()
  pendingUsage.set(record.id, current)

  const now = Date.now()
  const lastReportedAt = lastBlockedEventAt.get(record.id) || 0

  if (now - lastReportedAt >= BLOCK_EVENT_THROTTLE_MS) {
    lastBlockedEventAt.set(record.id, now)

    publishKillSwitchEvent(
      'kill_switch_blocking',
      'high',
      record,
      {
        pending_blocked_requests: current.count,
      }
    )

    reportKillSwitchState(
      'Kill Switch actively blocking requests',
      'high',
      true,
      'blocked'
    )
  }
}

export async function flushWorkKillSwitchUsage() {
  if (!pendingUsage.size) return 0

  const batch = [...pendingUsage.entries()]
  pendingUsage.clear()

  let flushed = 0

  for (const [id, usage] of batch) {
    try {
      const { error } = await supabase.rpc(
        'record_work_kill_switch_usage',
        {
          p_id: id,
          p_blocked_delta: usage.count,
          p_last_triggered_at: usage.lastTriggeredAt,
        }
      )

      if (error) throw error
      flushed += usage.count
    } catch (error) {
      const current = pendingUsage.get(id) || {
        count: 0,
        lastTriggeredAt: null,
      }

      current.count += usage.count

      if (
        !current.lastTriggeredAt
        || new Date(usage.lastTriggeredAt).getTime()
          > new Date(current.lastTriggeredAt).getTime()
      ) {
        current.lastTriggeredAt = usage.lastTriggeredAt
      }

      pendingUsage.set(id, current)

      console.error(
        'WORK_KILL_SWITCH_USAGE_FLUSH_ERROR:',
        error?.message || error
      )
    }
  }

  if (flushed > 0) {
    reportKillSwitchState(
      activeSwitches.size > 0
        ? 'Kill Switch active after usage flush'
        : 'Kill Switch sleeping; no active targets',
      'info',
      true
    )
  }

  return flushed
}

export async function listWorkKillSwitches({
  status = 'all',
  source = '',
  targetType = '',
  page = 1,
  limit = 50,
} = {}) {
  const safePage = Math.max(Number(page) || 1, 1)
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 100)
  const safeStatus = cleanText(status, 20).toLowerCase()
  const safeSource = normalizeSource(source)
  const safeTargetType = normalizeTargetType(targetType)
  const from = (safePage - 1) * safeLimit
  const to = from + safeLimit - 1

  let query = supabase
    .from('work_kill_switches')
    .select(
      'id,fingerprint,target_type,source,method,path,enabled,mode,reason,incident_id,activated_at,deactivated_at,expires_at,activation_count,blocked_requests,last_triggered_at,created_by,updated_by,created_at,updated_at',
      { count: 'exact' }
    )
    .order('updated_at', { ascending: false })
    .range(from, to)

  if (safeStatus === 'active') {
    query = query.eq('enabled', true)
  } else if (safeStatus === 'inactive') {
    query = query.eq('enabled', false)
  }

  if (safeSource) {
    query = query.eq('source', safeSource)
  }

  if (safeTargetType) {
    query = query.eq('target_type', safeTargetType)
  }

  const { data, count, error } = await query

  if (error) throw error

  const switches = Array.isArray(data) ? data : []
  const total = Math.max(Number(count) || 0, 0)

  return {
    switches,
    pagination: {
      page: safePage,
      limit: safeLimit,
      total,
      has_more: from + switches.length < total,
    },
  }
}

export function getActivePageKillSwitches(source = 'WEB') {
  const safeSource = normalizeSource(source)
  const now = Date.now()

  if (!safeSource) return []

  const records = []

  for (const record of activeSwitches.values()) {
    if (record.target_type !== 'page') continue

    if (isExpired(record, now)) {
      void disableExpiredRecord(record)
      continue
    }

    if (
      record.source !== 'ALL'
      && record.source !== safeSource
    ) {
      continue
    }

    records.push({
      id: record.id,
      path: record.path,
      source: record.source,
      expires_at: record.expires_at,
    })
  }

  return records.slice(0, 100)
}

export function getActiveWorkKillSwitchSnapshot() {
  const now = Date.now()

  return [...activeSwitches.values()]
    .filter((record) => !isExpired(record, now))
    .map((record) => ({
      id: record.id,
      fingerprint: record.fingerprint,
      target_type: record.target_type,
      source: record.source,
      method: record.method,
      path: record.path,
      mode: record.mode,
      reason: record.reason,
      incident_id: record.incident_id,
      activated_at: record.activated_at,
      expires_at: record.expires_at,
      blocked_requests: record.blocked_requests,
      last_triggered_at: record.last_triggered_at,
    }))
}

function expireCachedSwitches() {
  const now = Date.now()

  for (const record of [...activeSwitches.values()]) {
    if (isExpired(record, now)) {
      void disableExpiredRecord(record)
    }
  }
}

export async function startWorkKillSwitchService() {
  if (started) return

  started = true

  try {
    await reloadActiveWorkKillSwitches()

    publishKillSwitchEvent(
      'kill_switch_ready',
      'info',
      null,
      {
        active_count: activeSwitches.size,
      }
    )
  } catch (error) {
    reportKillSwitchState(
      'Kill Switch bootstrap failed',
      'critical',
      true,
      'degraded'
    )

    publishKillSwitchEvent(
      'kill_switch_bootstrap_failed',
      'critical',
      null,
      {
        error: cleanText(error?.message || error, 300),
      }
    )

    console.error(
      'WORK_KILL_SWITCH_BOOTSTRAP_ERROR:',
      error?.message || error
    )
  }

  usageTimer = setInterval(() => {
    void flushWorkKillSwitchUsage()
  }, USAGE_FLUSH_INTERVAL_MS)

  expiryTimer = setInterval(
    expireCachedSwitches,
    EXPIRY_CHECK_INTERVAL_MS
  )

  usageTimer.unref?.()
  expiryTimer.unref?.()

  console.log('WORK_KILL_SWITCH: service ready')
}
