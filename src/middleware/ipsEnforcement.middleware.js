import { isIP } from 'node:net'
import { findIpsDefense } from '../services/ipsCore.service.js'

function cleanText(value, maxLength = 500) {
  return String(value || '').trim().slice(0, maxLength)
}

function normalizeSingleIp(value) {
  const raw = cleanText(value, 150)
    .trim()
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
  const cookieHeader = String(req.headers.cookie || '')
  if (!cookieHeader) return ''

  const prefix = `${name}=`
  const pair = cookieHeader
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

function normalizeVisitorId(value) {
  const visitorId = cleanText(value, 200)

  if (!visitorId) return ''
  if (!/^[a-zA-Z0-9._:-]{6,200}$/.test(visitorId)) return ''

  return visitorId
}

function getVisitorId(req) {
  return normalizeVisitorId(
    req.headers['x-shadow-visitor-id']
      || req.headers['x-visitor-id']
      || req.query?.visitor_id
      || readCookieValue(req, 'shadow_visitor_id')
      || readCookieValue(req, 'shadowVisitorId')
  )
}

function buildIpsIdentity(req) {
  const accountId = cleanText(
    req.user?.user_id
      || req.user?.admin_id
      || req.user?.id,
    200
  )
  const visitorId = getVisitorId(req)
  const ipAddress = getClientIp(req)

  const identityKey = accountId
    ? `account:${accountId}`
    : visitorId
      ? `visitor:${visitorId}`
      : ipAddress
        ? `ip:${ipAddress}`
        : ''

  return {
    identity_key: identityKey,
    identity_type: accountId
      ? 'account'
      : visitorId
        ? 'visitor'
        : ipAddress
          ? 'ip'
          : 'unknown',
    account_id: accountId || null,
    visitor_id: visitorId || null,
    ip_address: ipAddress || null,
  }
}

function normalizePath(req) {
  const raw = String(req.originalUrl || req.url || req.path || '/')
    .split('?')[0]
    .slice(0, 500)

  return raw
    .split('/')
    .map((segment) => {
      if (!segment) return segment
      if (/^\d+$/.test(segment)) return ':id'
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(segment)) return ':id'
      if (/^[0-9a-f]{16,}$/i.test(segment)) return ':id'
      if (/^[A-Za-z0-9_-]{32,}$/.test(segment)) return ':id'
      return segment.slice(0, 100)
    })
    .join('/') || '/'
}

function requestSource(req, path) {
  const candidate = String(req.headers.origin || req.headers.referer || '').trim()

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

      if (hostname === 'localhost' || hostname === '127.0.0.1') {
        return path.startsWith('/api/admin/') ? 'ADMIN' : 'WEB'
      }

      return 'UNKNOWN'
    } catch {
      return 'UNKNOWN'
    }
  }

  if (path.startsWith('/api/admin/')) return 'ADMIN'
  if (path.startsWith('/api/')) return 'BACKEND'
  return 'UNKNOWN'
}

function shouldSkip(method, path) {
  if (method === 'OPTIONS') return true
  if (path === '/' || path === '/favicon.ico') return true
  if (path === '/health' || path.startsWith('/health/')) return true
  if (path === '/api/admin/work' || path.startsWith('/api/admin/work/')) return true
  return false
}

function findDefense({ identity, source, method, path }) {
  if (identity.identity_key) {
    const primary = findIpsDefense({
      ...identity,
      source,
      method,
      path,
    })

    if (primary) return primary
  }

  if (
    identity.ip_address
    && identity.identity_key !== `ip:${identity.ip_address}`
  ) {
    const fallback = findIpsDefense({
      identity_key: `ip:${identity.ip_address}`,
      identity_type: 'ip_fallback',
      account_id: null,
      visitor_id: null,
      ip_address: identity.ip_address,
      source,
      method,
      path,
    })

    if (fallback) return fallback
  }

  return null
}

function blockResponse(res, defense) {
  const action = String(defense.action || 'restrict').toLowerCase()

  if (action === 'watch') return false

  if (action === 'restrict') {
    res.setHeader('Retry-After', '60')
    res.setHeader('X-Shadow-IPS', 'restricted')

    res.status(429).json({
      ok: false,
      code: 'IPS_TEMPORARY_RESTRICTION',
      message: 'Request activity is temporarily restricted.',
      retry_after_seconds: 60,
    })

    return true
  }

  if (action === 'isolate') {
    res.setHeader('X-Shadow-IPS', 'isolated')

    res.status(403).json({
      ok: false,
      code: 'IPS_IDENTITY_ISOLATED',
      message: 'Request identity is temporarily isolated for security reasons.',
    })

    return true
  }

  res.setHeader('X-Shadow-IPS', 'blocked')

  res.status(403).json({
    ok: false,
    code: 'IPS_ACCESS_BLOCKED',
    message: 'Request access is temporarily blocked for security reasons.',
  })

  return true
}

export function ipsEnforcement(req, res, next) {
  try {
    const method = String(req.method || 'UNKNOWN').toUpperCase()
    const path = normalizePath(req)

    if (shouldSkip(method, path)) return next()

    const source = requestSource(req, path)
    const identity = buildIpsIdentity(req)

    const defense = findDefense({
      identity,
      source,
      method,
      path,
    })

    if (!defense) return next()
    if (!blockResponse(res, defense)) return next()

    return undefined
  } catch (error) {
    console.error(
      'IPS_ENFORCEMENT_ERROR:',
      error?.message || error
    )

    return next()
  }
}
