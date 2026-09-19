import {
  setWorkKillSwitch,
  getActiveWorkKillSwitchSnapshot,
} from './workKillSwitch.service.js'
import { isKillSwitchBootstrapVerified } from './workKillSwitchBootstrap.service.js'
import { releaseCriticalRouteCircuit } from '../middleware/workDetector.middleware.js'

const RETRY_INTERVAL_MS = 30 * 1000
const circuits = new Map()
const inFlight = new Map()
let retryTimer = null

function routeKey(method, path) {
  const safeMethod = String(method || '').trim().toUpperCase()
  const safePath = String(path || '').split('?')[0].trim()
  if (!safeMethod || !safePath.startsWith('/api/')) return ''
  return `${safeMethod}|${safePath}`
}

function persistCircuit(key) {
  const entry = circuits.get(key)
  if (!entry || entry.releasing) return Promise.resolve(null)
  if (entry.record) return Promise.resolve(entry.record)
  if (inFlight.has(key)) return inFlight.get(key)

  const pending = (async () => {
    try {
      const record = await setWorkKillSwitch({
        targetType: 'api',
        source: 'ALL',
        method: entry.method,
        path: entry.path,
        enabled: true,
        mode: 'automatic',
        reason: 'Critical route containment; Owner release required',
        incidentId: null,
        expiresAt: null,
        actor: 'critical_circuit_guard',
      })

      if (circuits.get(key) === entry && record?.enabled === true) {
        entry.record = record
      }

      return record?.enabled === true ? record : null
    } catch (error) {
      console.error(
        'CRITICAL_CIRCUIT_PERSIST_ERROR:',
        entry.method,
        entry.path,
        error?.message || error
      )
      return null
    } finally {
      inFlight.delete(key)
    }
  })()

  inFlight.set(key, pending)
  return pending
}

export function queueCriticalCircuit({ method, path } = {}) {
  const key = routeKey(method, path)
  if (!key) return null

  if (!circuits.has(key)) {
    circuits.set(key, {
      method: String(method).toUpperCase(),
      path: String(path).split('?')[0],
      record: null,
      releasing: false,
    })
  }

  void persistCircuit(key)
  return key
}

export function restoreCriticalCircuit(record) {
  if (
    record?.enabled === false ||
    record?.target_type !== 'api' ||
    record?.mode !== 'automatic' ||
    record?.source !== 'ALL' ||
    record?.expires_at
  ) return false

  const key = routeKey(record.method, record.path)
  if (!key) return false

  if (!circuits.has(key)) {
    circuits.set(key, {
      method: record.method,
      path: record.path,
      record,
      releasing: false,
    })
  }

  return true
}

export function ensureCriticalCircuitPersisted({ method, path } = {}) {
  const key = routeKey(method, path)
  if (!key || !circuits.has(key)) return Promise.resolve(null)
  return persistCircuit(key)
}

export async function disableCriticalCircuit({
  method,
  path,
  mode = 'automatic',
  reason = '',
  incidentId = null,
  actor = '',
} = {}) {
  const key = routeKey(method, path)
  if (!key) throw new Error('Invalid critical circuit target')

  const entry = circuits.get(key)
  if (entry?.releasing) throw new Error('Critical circuit release already in progress')
  if (entry) entry.releasing = true

  let released = false

  try {
    if (inFlight.has(key)) await inFlight.get(key)

    const record = await setWorkKillSwitch({
      targetType: 'api',
      source: 'ALL',
      method,
      path,
      enabled: false,
      mode,
      reason,
      incidentId,
      expiresAt: null,
      actor,
    })

    if (record?.enabled !== false) {
      throw new Error('Critical circuit release was not confirmed')
    }

    circuits.delete(key)
    released = true
    return record
  } finally {
    if (!released && entry) {
      entry.releasing = false
      if (!entry.record) void persistCircuit(key)
    }
  }
}

export function startCriticalCircuitPersistence() {
  if (retryTimer) return
  retryTimer = setInterval(() => {
    if (isKillSwitchBootstrapVerified()) {
      const persisted = new Map()
      for (const record of getActiveWorkKillSwitchSnapshot()) {
        if (
          record.target_type !== 'api' ||
          record.source !== 'ALL' ||
          record.mode !== 'automatic' ||
          record.expires_at
        ) continue
        const key = routeKey(record.method, record.path)
        if (key) persisted.set(key, record)
      }

      for (const [key, entry] of circuits) {
        if (!entry.record || entry.releasing || inFlight.has(key)) continue
        const current = persisted.get(key)
        if (current) {
          entry.record = current
          continue
        }
        circuits.delete(key)
        releaseCriticalRouteCircuit({ method: entry.method, path: entry.path })
      }
    }

    for (const [key, entry] of circuits) {
      if (!entry.record && !entry.releasing) void persistCircuit(key)
    }
  }, RETRY_INTERVAL_MS)
  retryTimer.unref?.()
}
