import { isIP } from 'node:net'
import { defendIps } from '../services/ipsCore.service.js'

const MAX_PATH_LENGTH = 1000

const sensitivePatterns = [
  /(^|\/)\.env(?:$|[./_-])/,
  /(^|\/)\.(?:git|svn|hg)(?:\/|$)/,
  /(^|\/)\.(?:ssh|aws)(?:\/|$)/,
  /(^|\/)(?:id_rsa|id_dsa|id_ecdsa|id_ed25519)(?:\.pub)?(?:$|\/)/,
  /^\/(?:wp-config\.php|phpinfo\.php|composer\.(?:json|lock)|package(?:-lock)?\.json|yarn\.lock|pnpm-lock\.yaml|\.npmrc|\.htaccess|\.htpasswd)$/,
  /^\/(?:docker-compose(?:\.[^/]+)?\.ya?ml|dockerfile|\.dockerignore)$/,
  /^\/(?:config|settings|secrets|credentials)\.(?:json|ya?ml|js|cjs|mjs|ts)$/,
  /^\/(?:src|private|server)(?:\/|$)/,
  /(^|\/)(?:backup|backups|dump|dumps)(?:\/|$)/,
  /(^|\/)[^/]+\.(?:bak|backup|old|orig|save|swp|sql|dump|sqlite|sqlite3)(?:$|\/)/,
  /(^|\/)etc\/passwd(?:$|\/)/,
  /(^|\/)proc\/(?:self|\d+)\/(?:environ|cmdline)(?:$|\/)/,
  /(^|\/)windows\/win\.ini(?:$|\/)/,
]

function cleanText(value, maxLength = 500) {
  return String(value || '').trim().slice(0, maxLength)
}

function normalizeSingleIp(value) {
  const raw = cleanText(value, 150)
    .replace(/^::ffff:/, '')

  return isIP(raw) ? raw : ''
}

function getForwardedIp(value) {
  return String(value || '')
    .split(',')
    .map((item) => normalizeSingleIp(item))
    .find(Boolean) || ''
}

function getClientIp(req) {
  return (
    normalizeSingleIp(req.headers['cf-connecting-ip'])
    || normalizeSingleIp(req.headers['true-client-ip'])
    || normalizeSingleIp(req.headers['x-real-ip'])
    || getForwardedIp(req.headers['x-forwarded-for'])
    || normalizeSingleIp(req.socket?.remoteAddress)
    || ''
  )
}

function readCookieValue(req, name) {
  const header = String(req.headers.cookie || '')
  if (!header) return ''

  const prefix = `${name}=`
  const pair = header
    .split(';')
    .map((item) => item.trim())
    .find((item) => item.startsWith(prefix))

  if (!pair) return ''

  try {
    return decodeURIComponent(pair.slice(prefix.length))
  } catch {
    return pair.slice(prefix.length)
  }
}

function getVisitorId(req) {
  const value = cleanText(
    req.headers['x-shadow-visitor-id']
      || req.headers['x-visitor-id']
      || readCookieValue(req, 'shadow_visitor_id')
      || readCookieValue(req, 'shadowVisitorId'),
    200
  )

  return /^[a-zA-Z0-9._:-]{6,200}$/.test(value)
    ? value
    : ''
}

function decodePath(value) {
  let path = String(value || '/')
    .split('?')[0]
    .slice(0, MAX_PATH_LENGTH)

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const decoded = decodeURIComponent(path)
      if (decoded === path) break
      path = decoded
    } catch {
      break
    }
  }

  path = path
    .replace(/\0/g, '')
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .toLowerCase()

  return path.startsWith('/') ? path : `/${path}`
}

function isSensitivePath(path) {
  return sensitivePatterns.some((pattern) => pattern.test(path))
}

function requestSource(req, path) {
  const candidate = cleanText(
    req.headers.origin || req.headers.referer,
    500
  )

  if (candidate) {
    try {
      const hostname = new URL(candidate).hostname.toLowerCase()

      if (hostname === 'admin.shadowerabook.site') return 'ADMIN'

      if (
        hostname === 'shadowerabook.site'
        || hostname === 'www.shadowerabook.site'
      ) {
        return 'WEB'
      }
    } catch {
      return 'UNKNOWN'
    }
  }

  if (path.startsWith('/api/admin/')) return 'ADMIN'
  if (path.startsWith('/api/')) return 'BACKEND'
  return 'UNKNOWN'
}

function buildIncident(req, path) {
  const visitorId = getVisitorId(req)
  const ipAddress = getClientIp(req)

  const identityKey = visitorId
    ? `visitor:${visitorId}`
    : ipAddress
      ? `ip:${ipAddress}`
      : 'unknown'

  return {
    identity_key: identityKey,
    identity_type: visitorId
      ? 'visitor'
      : ipAddress
        ? 'ip'
        : 'unknown',
    account_id: null,
    visitor_id: visitorId || null,
    ip_address: ipAddress || null,
    source: requestSource(req, path),
    method: String(req.method || 'UNKNOWN').toUpperCase(),
    path,
    estimated_requests_per_minute: 0,
    peak_requests_per_minute: 0,
  }
}

export function sensitivePathGuard(req, res, next) {
  if (req.method === 'OPTIONS') return next()

  const path = decodePath(
    req.originalUrl || req.url || req.path || '/'
  )

  if (!isSensitivePath(path)) return next()

  try {
    defendIps(
      buildIncident(req, path),
      'block'
    )
  } catch (error) {
    console.error(
      'SENSITIVE_PATH_GUARD_IPS_ERROR:',
      error?.message || error
    )
  }

  return res.status(404).json({
    ok: false,
    message: 'Route not found',
  })
}
