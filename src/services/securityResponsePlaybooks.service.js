import { resolveTamperIncident } from './tamperGuard.service.js'
import { ensureCriticalCircuitPersisted } from './criticalCircuitPersistence.service.js'

function cleanText(value, maxLength = 500) {
  return String(value || '').trim().slice(0, maxLength)
}

function safeObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return { ...value }
}

function normalizeSource(value) {
  const source = cleanText(value, 30).toUpperCase()
  return ['WEB', 'ADMIN', 'BACKEND'].includes(source) ? source : ''
}

function normalizeMethod(value) {
  return cleanText(value, 16).toUpperCase()
}

function normalizePath(value) {
  const raw = cleanText(value, 500).split('?')[0] || '/'
  const path = raw.startsWith('/') ? raw : `/${raw}`
  return path.replace(/\/{2,}/g, '/')
}

async function executeDistributedRouteContainment(response) {
  const payload = safeObject(response?.payload)
  const severity = cleanText(response?.trigger_severity, 20).toLowerCase()

  if (severity !== 'critical') {
    return {
      ok: true,
      executed: false,
      code: 'PLAYBOOK_WAITING_FOR_CRITICAL',
    }
  }

  const source = normalizeSource(payload.source)
  const method = normalizeMethod(payload.method)
  const path = normalizePath(payload.path)

  if (!source || !method || !path.startsWith('/api/')) {
    return {
      ok: false,
      executed: false,
      code: 'PLAYBOOK_ROUTE_TARGET_INVALID',
    }
  }

  const record = await ensureCriticalCircuitPersisted({ method, path })

  if (!record) {
    return {
      ok: false,
      executed: false,
      code: 'PLAYBOOK_CIRCUIT_PERSIST_PENDING',
    }
  }

  return {
    ok: true,
    executed: true,
    code: 'PLAYBOOK_ROUTE_CONTAINED',
    action: 'kill_switch_enable',
    target: {
      id: record?.id || null,
      source: 'ALL',
      method,
      path,
      expires_at: null,
    },
  }
}

export async function executeSecurityResponsePlaybook(response = {}) {
  const playbook = cleanText(response?.playbook, 100).toLowerCase()

  if (!playbook) {
    return {
      ok: false,
      executed: false,
      code: 'PLAYBOOK_REQUIRED',
    }
  }

  if (playbook === 'distributed_route_containment') {
    return executeDistributedRouteContainment(response)
  }

  return {
    ok: true,
    executed: false,
    code: 'PLAYBOOK_NO_AUTOMATIC_ACTION',
  }
}

export function executeSecurityResponseResolution(
  response = {},
  {
    approved = false,
    actor = '',
    reason = '',
  } = {}
) {
  const playbook = cleanText(response?.playbook, 100).toLowerCase()

  if (!approved) {
    return {
      ok: false,
      executed: false,
      code: 'PLAYBOOK_RESOLUTION_APPROVAL_REQUIRED',
    }
  }

  if (!playbook) {
    return {
      ok: false,
      executed: false,
      code: 'PLAYBOOK_REQUIRED',
    }
  }

  if (playbook === 'distributed_route_containment') {
    return {
      ok: false,
      executed: false,
      code: 'PLAYBOOK_ROUTE_OWNER_RELEASE_REQUIRED',
    }
  }

  if (playbook !== 'tamper_containment') {
    return {
      ok: true,
      executed: false,
      code: 'PLAYBOOK_NO_RESOLUTION_ACTION',
    }
  }

  const payload = safeObject(response?.payload)
  const incidentId = cleanText(payload.incident_id, 100)
  const safeActor = cleanText(actor, 200)

  if (!incidentId) {
    return {
      ok: false,
      executed: false,
      code: 'PLAYBOOK_TAMPER_INCIDENT_REQUIRED',
    }
  }

  if (!safeActor) {
    return {
      ok: false,
      executed: false,
      code: 'PLAYBOOK_RESOLUTION_ACTOR_REQUIRED',
    }
  }

  const resolved = resolveTamperIncident({
    incidentId,
    actor: safeActor,
    reason: cleanText(reason, 500) || 'Tamper incident manually approved as resolved',
  })

  if (!resolved) {
    return {
      ok: false,
      executed: false,
      code: 'PLAYBOOK_TAMPER_INCIDENT_NOT_FOUND',
    }
  }

  return {
    ok: true,
    executed: true,
    code: 'PLAYBOOK_TAMPER_RESOLVED',
    action: 'tamper_incident_resolve',
    incident_id: incidentId,
  }
}
