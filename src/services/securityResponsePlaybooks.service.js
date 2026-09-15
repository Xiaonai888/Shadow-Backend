import { setWorkKillSwitch } from './workKillSwitch.service.js'

const AUTO_ROUTE_CONTAINMENT_MS = 10 * 60 * 1000

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

  const expiresAt = new Date(
    Date.now() + AUTO_ROUTE_CONTAINMENT_MS
  ).toISOString()

  const record = await setWorkKillSwitch({
    targetType: 'api',
    source,
    method,
    path,
    enabled: true,
    mode: 'automatic',
    reason: 'Security Response Assistant critical route containment',
    incidentId: cleanText(response?.id, 100) || null,
    expiresAt,
    actor: 'security_response_assistant',
  })

  return {
    ok: true,
    executed: true,
    code: 'PLAYBOOK_ROUTE_CONTAINED',
    action: 'kill_switch_enable',
    target: {
      id: record?.id || null,
      source,
      method,
      path,
      expires_at: record?.expires_at || expiresAt,
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
