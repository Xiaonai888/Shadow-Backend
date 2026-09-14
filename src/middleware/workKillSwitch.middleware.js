import {
  findActiveWorkKillSwitch,
  recordWorkKillSwitchBlocked,
} from '../services/workKillSwitch.service.js'

const ALWAYS_BYPASS_PREFIXES = [
  '/api/admin/work',
]

const AUTO_BYPASS_PREFIXES = [
  '/api/auth',
  '/api/admin/login-guard',
  '/api/purchase/aba/callback',
  '/api/telegram/webhook/',
]

function normalizePath(req) {
  const raw = String(
    req.originalUrl ||
    req.url ||
    req.path ||
    '/'
  )
    .split('?')[0]
    .slice(0, 500)

  const path = raw.startsWith('/') ? raw : `/${raw}`
  return path.replace(/\/{2,}/g, '/')
}

function requestSource(req, path) {
  const candidate = String(
    req.headers.origin ||
    req.headers.referer ||
    ''
  ).trim()

  if (candidate) {
    try {
      const hostname = new URL(candidate)
        .hostname
        .toLowerCase()

      if (hostname === 'admin.shadowerabook.site') {
        return 'ADMIN'
      }

      if (
        hostname === 'shadowerabook.site' ||
        hostname === 'www.shadowerabook.site'
      ) {
        return 'WEB'
      }

      if (
        hostname === 'localhost' ||
        hostname === '127.0.0.1'
      ) {
        return path.startsWith('/api/admin/')
          ? 'ADMIN'
          : 'WEB'
      }

      return 'BACKEND'
    } catch {
      return 'BACKEND'
    }
  }

  if (path.startsWith('/api/admin/')) {
    return 'ADMIN'
  }

  return 'BACKEND'
}

function startsWithAny(path, prefixes) {
  return prefixes.some((prefix) => (
    path === prefix ||
    path.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`)
  ))
}

function isAlwaysBypassed(path) {
  return startsWithAny(path, ALWAYS_BYPASS_PREFIXES)
}

function isAutomaticBypassed(path) {
  return startsWithAny(path, AUTO_BYPASS_PREFIXES)
}

function retryAfterSeconds(expiresAt) {
  if (!expiresAt) return null

  const expiresMs = new Date(expiresAt).getTime()

  if (!Number.isFinite(expiresMs)) return null

  return Math.max(
    1,
    Math.ceil((expiresMs - Date.now()) / 1000)
  )
}

export function workKillSwitch(req, res, next) {
  try {
    const method = String(
      req.method ||
      'UNKNOWN'
    ).toUpperCase()

    if (method === 'OPTIONS') {
      return next()
    }

    const path = normalizePath(req)

    if (
      !path.startsWith('/api/') ||
      isAlwaysBypassed(path)
    ) {
      return next()
    }

    const source = requestSource(req, path)

    const record = findActiveWorkKillSwitch({
      targetType: 'api',
      source,
      method,
      path,
    })

    if (!record) {
      return next()
    }

    if (
      record.mode === 'automatic' &&
      isAutomaticBypassed(path)
    ) {
      return next()
    }

    recordWorkKillSwitchBlocked(record)

    const retryAfter = retryAfterSeconds(
      record.expires_at
    )

    if (retryAfter) {
      res.set('Retry-After', String(retryAfter))
    }

    res.set(
      'X-Shadow-Work-Switch',
      'active'
    )

    return res.status(503).json({
      ok: false,
      code: 'WORK_CIRCUIT_OPEN',
      maintenance: true,
      message:
        'This feature is temporarily unavailable for maintenance.',
      retry_after_seconds: retryAfter,
    })
  } catch (error) {
    console.error(
      'WORK_KILL_SWITCH_MIDDLEWARE_ERROR:',
      error?.message || error
    )

    return next()
  }
}
