import jwt from 'jsonwebtoken'
import { supabase } from '../config/supabase.js'
import { validateAdminSession } from '../services/adminDeviceAccess.service.js'

const RETRYABLE_STATUS = new Set([408, 429, 502, 503, 504])
const RETRYABLE_CODES = new Set([
  '53300', '53400', '57P03', 'PGRST002',
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN',
])

function getBearerToken(req) {
  const authHeader = String(req.headers?.authorization || '')
  return authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : ''
}

function isTemporaryFailure(error) {
  const status = Number(error?.status || error?.statusCode || 0)
  const code = String(error?.code || error?.cause?.code || '').toUpperCase()
  const message = String(error?.message || '')
  return RETRYABLE_STATUS.has(status) ||
    RETRYABLE_CODES.has(code) ||
    /^08[A-Z0-9]{3}$/.test(code) ||
    /fetch failed|network error|socket hang up|gateway timeout/i.test(message)
}

async function verifiedLookup(stage, operation) {
  try {
    return await operation()
  } catch (firstError) {
    if (isTemporaryFailure(firstError)) {
      try {
        return await operation()
      } catch (lastError) {
        const failure = new Error('Admin verification database request failed', { cause: lastError })
        failure.authStage = stage
        throw failure
      }
    }
    const failure = new Error('Admin verification database request failed', { cause: firstError })
    failure.authStage = stage
    throw failure
  }
}

async function loadAdminAccount(decoded) {
  const adminId = String(decoded?.admin_id || '').trim()
  const email = String(decoded?.email || '').trim().toLowerCase()

  if (!adminId && !email) return null

  let query = supabase
    .from('admin_users')
    .select('id, email, name, role, role_id, status')
    .limit(1)

  query = adminId ? query.eq('id', adminId) : query.eq('email', email)

  const { data, error } = await query.maybeSingle()
  if (error) throw error
  return data || null
}

async function loadRoleAccess(roleId) {
  if (!roleId) return { role: null, permissionKeys: [] }

  const { data: role, error: roleError } = await supabase
    .from('admin_roles')
    .select('id, system_key, name, description, is_system, is_protected')
    .eq('id', roleId)
    .maybeSingle()
  if (roleError) throw roleError
  if (!role) return { role: null, permissionKeys: [] }

  const { data: links, error: linksError } = await supabase
    .from('admin_role_permissions')
    .select('permission_id')
    .eq('role_id', role.id)
  if (linksError) throw linksError

  const permissionIds = [...new Set((links || [])
    .map((item) => item.permission_id)
    .filter(Boolean))]
  if (!permissionIds.length) return { role, permissionKeys: [] }

  const { data: permissions, error: permissionsError } = await supabase
    .from('admin_permissions')
    .select('permission_key')
    .in('id', permissionIds)
  if (permissionsError) throw permissionsError

  return {
    role,
    permissionKeys: (permissions || [])
      .map((item) => String(item.permission_key || '').trim())
      .filter(Boolean),
  }
}

async function authenticateAdminRequest(req) {
  const token = getBearerToken(req)
  if (!token) {
    return { ok: false, status: 401, code: 'ADMIN_TOKEN_REQUIRED', message: 'Admin token required' }
  }
  if (!process.env.JWT_SECRET) {
    return { ok: false, status: 500, code: 'ADMIN_JWT_CONFIG_MISSING', message: 'Admin verification is not configured.' }
  }

  let decoded
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET)
  } catch {
    return { ok: false, status: 401, code: 'ADMIN_TOKEN_INVALID', message: 'Invalid or expired admin token' }
  }

  const sessionCheck = await verifiedLookup('session', () => validateAdminSession({ decoded, req }))
  if (!sessionCheck.ok) {
    return {
      ok: false,
      status: sessionCheck.status || 401,
      code: sessionCheck.code || 'ADMIN_SESSION_INVALID',
      message: sessionCheck.message || 'Admin session is invalid. Please login again.',
    }
  }

  const account = await verifiedLookup('account', () => loadAdminAccount(decoded))
  if (!account) {
    return { ok: false, status: 404, code: 'ADMIN_ACCOUNT_NOT_FOUND', message: 'Admin account not found' }
  }

  const legacyRole = String(account.role || '').trim().toLowerCase()
  if (!['owner', 'admin', 'staff'].includes(legacyRole)) {
    return { ok: false, status: 403, code: 'ADMIN_ROLE_NOT_ALLOWED', message: 'This account is not allowed to access Shadow Admin' }
  }

  const status = String(account.status || 'active').trim().toLowerCase()
  if (status !== 'active') {
    return {
      ok: false,
      status: 403,
      code: 'ADMIN_ACCOUNT_INACTIVE',
      message: status === 'suspended' ? 'This staff account is suspended' : 'This staff account is inactive',
    }
  }

  if (legacyRole === 'owner' || legacyRole === 'admin') {
    return {
      ok: true,
      admin: {
        ...decoded,
        admin_id: account.id,
        email: account.email,
        actor: account.name || account.email,
        name: account.name,
        role: legacyRole,
        role_id: account.role_id || null,
        role_name: legacyRole === 'owner' ? 'Owner' : 'Admin',
        status,
        permission_keys: ['*'],
        has_all_permissions: true,
        session: sessionCheck.session,
        device: sessionCheck.device,
      },
    }
  }

  if (!account.role_id) {
    return { ok: false, status: 403, code: 'ADMIN_ROLE_REQUIRED', message: 'This staff account does not have a saved role' }
  }

  const access = await verifiedLookup('role', () => loadRoleAccess(account.role_id))
  if (!access.role) {
    return { ok: false, status: 403, code: 'ADMIN_ROLE_NOT_FOUND', message: 'The saved role assigned to this staff account was not found' }
  }
  if (access.role.system_key === 'owner' || access.role.is_protected) {
    return { ok: false, status: 403, code: 'ADMIN_PROTECTED_ROLE_INVALID', message: 'Protected system role cannot be assigned to a staff account' }
  }

  return {
    ok: true,
    admin: {
      ...decoded,
      admin_id: account.id,
      email: account.email,
      actor: account.name || account.email,
      name: account.name,
      role: 'staff',
      role_id: access.role.id,
      role_name: access.role.name,
      status,
      permission_keys: access.permissionKeys,
      has_all_permissions: false,
      session: sessionCheck.session,
      device: sessionCheck.device,
    },
  }
}

function sendAccessError(res, result) {
  return res.status(result.status || 403).json({
    ok: false,
    ...(result.code ? { code: result.code } : {}),
    message: result.message || 'Admin access denied',
  })
}

function sendVerificationError(req, res, error, scope) {
  const original = error?.cause || error
  const stage = ['session', 'account', 'role'].includes(error?.authStage)
    ? error.authStage
    : 'unknown'
  const temporary = isTemporaryFailure(original)
  console.error('ADMIN VERIFICATION ERROR:', {
    scope,
    stage,
    code: String(original?.code || 'UNKNOWN').slice(0, 48),
    status: Number(original?.status || original?.statusCode || 0),
    message: String(original?.message || 'Unknown verification error').slice(0, 240),
    route: String(req.originalUrl || req.path || '').split('?')[0].slice(0, 160),
  })
  if (temporary) res.set('Retry-After', '2')
  return res.status(temporary ? 503 : 500).json({
    ok: false,
    code: `ADMIN_${stage.toUpperCase()}_VERIFICATION_FAILED`,
    message: `Failed to verify admin ${scope} (${stage}).`,
  })
}

export function adminHasPermission(admin, permissionKey) {
  if (admin?.has_all_permissions) return true
  const key = String(permissionKey || '').trim()
  if (!key) return false
  return Array.isArray(admin?.permission_keys) && admin.permission_keys.includes(key)
}

export async function requireAdminSession(req, res, next) {
  let result
  try {
    result = await authenticateAdminRequest(req)
  } catch (error) {
    return sendVerificationError(req, res, error, 'access')
  }
  if (!result.ok) return sendAccessError(res, result)
  req.admin = result.admin
  return next()
}

export function requireAdminPermission(permissionKey) {
  return async function adminPermissionMiddleware(req, res, next) {
    let result
    try {
      result = await authenticateAdminRequest(req)
    } catch (error) {
      return sendVerificationError(req, res, error, 'permission')
    }
    if (!result.ok) return sendAccessError(res, result)
    if (!adminHasPermission(result.admin, permissionKey)) {
      return res.status(403).json({
        ok: false,
        code: 'ADMIN_PERMISSION_DENIED',
        message: `Permission required: ${permissionKey}`,
      })
    }
    req.admin = result.admin
    return next()
  }
}
