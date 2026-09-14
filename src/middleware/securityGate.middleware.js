import {
  isSecuritySafeMode,
  publishSecurityEvent,
  reportGuardState,
} from '../services/securityControlPlane.service.js'

const MAX_DENY_KEYS = 500
const DENY_EVENT_THROTTLE_MS = 60 * 1000

const registeredGates = new Map()
const denyEventTimes = new Map()

let lastReportedState = ''

function cleanText(value, maxLength = 500) {
  return String(value || '').trim().slice(0, maxLength)
}

function normalizeList(value, maxLength = 100) {
  const items = Array.isArray(value) ? value : []

  return [...new Set(
    items
      .map((item) => cleanText(item, maxLength).toLowerCase())
      .filter(Boolean)
  )]
}

function normalizeMethod(value) {
  return cleanText(value, 16).toUpperCase() || 'UNKNOWN'
}

function normalizePath(req) {
  return cleanText(
    req.originalUrl || req.url || req.path || '/',
    500
  ).split('?')[0] || '/'
}

function extractIdentity(req) {
  const admin = req.admin && typeof req.admin === 'object'
    ? req.admin
    : null
  const user = req.user && typeof req.user === 'object'
    ? req.user
    : null
  const principal = admin || user

  if (!principal) {
    return {
      verified: false,
      id: '',
      type: 'anonymous',
      role: '',
      permissions: [],
    }
  }

  const id = cleanText(
    principal.admin_id
      || principal.user_id
      || principal.id
      || principal.sub,
    200
  )

  const role = cleanText(principal.role, 80).toLowerCase()
  const permissionSource =
    principal.permission_keys
    || principal.permissions
    || []

  return {
    verified: Boolean(id),
    id,
    type: admin ? 'admin' : 'user',
    role,
    permissions: normalizeList(permissionSource, 200),
    hasAllPermissions:
      principal.has_all_permissions === true
      || normalizeList(permissionSource, 200).includes('*'),
  }
}

function hasRequiredPermissions(
  identity,
  requiredPermissions,
  requireAll
) {
  if (requiredPermissions.length === 0) return true
  if (identity.hasAllPermissions) return true

  const owned = new Set(identity.permissions)

  return requireAll
    ? requiredPermissions.every((key) => owned.has(key))
    : requiredPermissions.some((key) => owned.has(key))
}

function evictOldestDenyKey() {
  let oldestKey = ''
  let oldestAt = Infinity

  for (const [key, at] of denyEventTimes.entries()) {
    if (at < oldestAt) {
      oldestAt = at
      oldestKey = key
    }
  }

  if (oldestKey) denyEventTimes.delete(oldestKey)
}

function shouldPublishDeny(key) {
  const now = Date.now()
  const previous = denyEventTimes.get(key) || 0

  if (now - previous < DENY_EVENT_THROTTLE_MS) {
    return false
  }

  if (
    !denyEventTimes.has(key)
    && denyEventTimes.size >= MAX_DENY_KEYS
  ) {
    evictOldestDenyKey()
  }

  denyEventTimes.set(key, now)
  return true
}

function reportGateState(
  state,
  reason,
  severity = 'info',
  force = false
) {
  if (!force && state === lastReportedState) return

  lastReportedState = state

  reportGuardState({
    guard: 'security_gate',
    state,
    reason,
    details: {
      registered_gates: registeredGates.size,
    },
    severity,
  })
}

function denyRequest({
  req,
  res,
  gateId,
  identity,
  status,
  code,
  message,
  reason,
  severity,
}) {
  const method = normalizeMethod(req.method)
  const path = normalizePath(req)
  const denyKey = [
    gateId,
    identity.id || 'anonymous',
    method,
    path,
    code,
  ].join('|')

  if (shouldPublishDeny(denyKey)) {
    publishSecurityEvent({
      source: 'security_gate',
      target: 'control_plane',
      type: 'security_gate_denied',
      severity,
      payload: {
        gate_id: gateId,
        reason,
        code,
        identity_type: identity.type,
        role: identity.role || null,
        method,
        path,
      },
    })
  }

  reportGateState(
    'defending',
    reason,
    severity
  )

  res.setHeader('X-Shadow-Security-Gate', 'denied')

  return res.status(status).json({
    ok: false,
    code,
    message,
  })
}

export function createSecurityGate({
  gateId,
  roles = [],
  permissions = [],
  requireAllPermissions = true,
  allowOwner = true,
  allowInSafeMode = false,
  methods = [],
} = {}) {
  const safeGateId = cleanText(gateId, 100).toLowerCase()

  if (!safeGateId) {
    throw new Error('Security Gate requires gateId')
  }

  const safeRoles = normalizeList(roles, 80)
  const safePermissions = normalizeList(permissions, 200)
  const safeMethods = [...new Set(
    (Array.isArray(methods) ? methods : [])
      .map((method) => normalizeMethod(method))
      .filter((method) => method !== 'UNKNOWN')
  )]

  registeredGates.set(safeGateId, {
    gate_id: safeGateId,
    roles: safeRoles,
    permissions: safePermissions,
    require_all_permissions: Boolean(requireAllPermissions),
    allow_owner: Boolean(allowOwner),
    allow_in_safe_mode: Boolean(allowInSafeMode),
    methods: safeMethods,
  })

  reportGateState(
    'monitoring',
    'Security Gate ready',
    'info'
  )

  return function securityGateMiddleware(req, res, next) {
    const method = normalizeMethod(req.method)

    if (method === 'OPTIONS') return next()

    if (
      safeMethods.length > 0
      && !safeMethods.includes(method)
    ) {
      return next()
    }

    const identity = extractIdentity(req)

    if (isSecuritySafeMode() && !allowInSafeMode) {
      return denyRequest({
        req,
        res,
        gateId: safeGateId,
        identity,
        status: 503,
        code: 'SECURITY_GATE_SAFE_MODE',
        message: 'Sensitive access is temporarily unavailable.',
        reason: 'Security Gate denied sensitive access during safe mode',
        severity: 'critical',
      })
    }

    if (!identity.verified) {
      return denyRequest({
        req,
        res,
        gateId: safeGateId,
        identity,
        status: 401,
        code: 'SECURITY_GATE_IDENTITY_REQUIRED',
        message: 'Verified identity is required.',
        reason: 'Security Gate rejected an unverified identity',
        severity: 'high',
      })
    }

    const ownerBypass = allowOwner && identity.role === 'owner'

    if (
      !ownerBypass
      && safeRoles.length > 0
      && !safeRoles.includes(identity.role)
    ) {
      return denyRequest({
        req,
        res,
        gateId: safeGateId,
        identity,
        status: 403,
        code: 'SECURITY_GATE_ROLE_DENIED',
        message: 'This identity is not allowed through this security gate.',
        reason: 'Security Gate rejected an unauthorized role',
        severity: 'high',
      })
    }

    if (
      !ownerBypass
      && !hasRequiredPermissions(
        identity,
        safePermissions,
        Boolean(requireAllPermissions)
      )
    ) {
      return denyRequest({
        req,
        res,
        gateId: safeGateId,
        identity,
        status: 403,
        code: 'SECURITY_GATE_PERMISSION_DENIED',
        message: 'Required security permission is missing.',
        reason: 'Security Gate rejected missing permission',
        severity: 'high',
      })
    }

    req.securityGate = {
      gate_id: safeGateId,
      verified: true,
      identity_type: identity.type,
      identity_id: identity.id,
      role: identity.role || null,
      checked_at: Date.now(),
    }

    if (lastReportedState === 'defending') {
      publishSecurityEvent({
        source: 'security_gate',
        target: 'control_plane',
        type: 'security_gate_recovered',
        severity: 'info',
        payload: {
          gate_id: safeGateId,
        },
      })

      reportGateState(
        'monitoring',
        'Security Gate operating normally',
        'info',
        true
      )
    }

    res.setHeader('X-Shadow-Security-Gate', 'verified')
    return next()
  }
}

export function getSecurityGateSnapshot() {
  return {
    state: lastReportedState || 'monitoring',
    registered_count: registeredGates.size,
    gates: [...registeredGates.values()].map((item) => ({
      ...item,
      roles: [...item.roles],
      permissions: [...item.permissions],
      methods: [...item.methods],
    })),
  }
}
