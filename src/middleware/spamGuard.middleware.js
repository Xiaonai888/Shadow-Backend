import { isIP } from 'node:net'
import jwt from 'jsonwebtoken'
import { supabase } from '../config/supabase.js'

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
  const candidates = String(value || '')
    .split(',')
    .map((item) => normalizeSingleIp(item))
    .filter(Boolean)

  return candidates[0] || ''
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

function readBearerAccountId(req) {
  try {
    const authHeader = cleanText(req.headers.authorization, 5000)
    const token = authHeader.startsWith('Bearer ')
      ? authHeader.slice(7)
      : ''

    if (!token || !process.env.JWT_SECRET) return ''

    const decoded = jwt.verify(token, process.env.JWT_SECRET)

    return cleanText(
      decoded?.user_id
        || decoded?.admin_id
        || decoded?.id
        || decoded?.sub,
      200
    )
  } catch {
    return ''
  }
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
      || req.body?.visitor_id
      || req.query?.visitor_id
      || readCookieValue(req, 'shadow_visitor_id')
      || readCookieValue(req, 'shadowVisitorId')
  )
}

function buildGuardIdentity(req) {
  const accountId = cleanText(
    req.user?.user_id
      || req.user?.admin_id
      || req.user?.id,
    200
  ) || readBearerAccountId(req)

  const visitorId = getVisitorId(req)
  const ipAddress = getClientIp(req)

  const guardKey = accountId
    ? `account:${accountId}`
    : visitorId
      ? `visitor:${visitorId}`
      : ipAddress
        ? `ip:${ipAddress}`
        : ''

  return {
    guardKey,
    accountId,
    visitorId,
    ipAddress,
    identityType: accountId
      ? 'account'
      : visitorId
        ? 'visitor'
        : ipAddress
          ? 'ip'
          : 'unknown',
  }
}

function shouldSkipPath(path, skipPaths) {
  return skipPaths.some((item) => (
    item.endsWith('*')
      ? path.startsWith(item.slice(0, -1))
      : path === item
  ))
}

function normalizeResult(data) {
  if (Array.isArray(data)) return data[0] || null
  return data || null
}

function resolveGuardCode(result) {
  const status = String(
    result?.block_status
      || result?.status
      || ''
  ).toLowerCase()

  if (
    result?.is_permanent_blocked
    || status === 'permanent_block'
  ) {
    return {
      code: 'PERMANENT_BLOCK',
      header: 'permanent-block',
      status: 'permanent_block',
      message: 'This identity has been permanently blocked.',
      retryAfter: 86400,
    }
  }

  if (status === 'seven_day_quarantine') {
    return {
      code: 'SEVEN_DAY_QUARANTINE',
      header: 'seven-day-quarantine',
      status: 'seven_day_quarantine',
      message: 'This identity is in 7-day quarantine.',
      retryAfter: Math.max(
        1,
        Number(result.retry_after_seconds || 604800)
      ),
    }
  }

  return {
    code: 'TEMPORARY_COOLDOWN',
    header: 'temporary-cooldown',
    status: 'temporary_cooldown',
    message: 'Too many requests. Please wait before trying again.',
    retryAfter: Math.max(
      1,
      Number(result?.retry_after_seconds || 60)
    ),
  }
}

export function createSpamGuard({
  scope = 'global',
  threshold = 120,
  windowSeconds = 60,
  skipPaths = [],
  failOpen = true,
} = {}) {
  const safeScope = cleanText(scope, 80) || 'global'
  const safeThreshold = Math.max(
    1,
    Number(threshold) || 120
  )
  const safeWindowSeconds = Math.max(
    1,
    Number(windowSeconds) || 60
  )

  return async function spamGuardMiddleware(
    req,
    res,
    next
  ) {
    if (req.method === 'OPTIONS') return next()

    const requestPath = cleanText(
      req.originalUrl || req.url || '/',
      500
    )

    if (shouldSkipPath(requestPath, skipPaths)) {
      return next()
    }

    const identity = buildGuardIdentity(req)

    if (!identity.guardKey) return next()

    try {
      const { data, error } = await supabase.rpc(
        'evaluate_spam_guard',
        {
          p_guard_key: identity.guardKey,
          p_scope: safeScope,
          p_ip_address: identity.ipAddress || null,
          p_visitor_id: identity.visitorId || null,
          p_account_id: identity.accountId || null,
          p_endpoint: requestPath,
          p_method: req.method,
          p_threshold: safeThreshold,
          p_window_seconds: safeWindowSeconds,
        }
      )

      if (error) throw error

      const result = normalizeResult(data)

      if (!result) return next()

      req.spamGuard = {
        scope: safeScope,
        guard_key: identity.guardKey,
        identity_type: identity.identityType,
        request_count: Number(
          result.request_count || 0
        ),
        offense_count: Number(
          result.offense_count || 0
        ),
        spam_score: Number(
          result.spam_score || 0
        ),
        cooldown_until:
          result.cooldown_until || null,
        quarantine_until:
          result.quarantine_until || null,
        block_status:
          result.block_status || 'allowed',
      }

      if (result.allowed !== false) return next()

      const resolved = resolveGuardCode(result)

      res.setHeader(
        'Retry-After',
        String(resolved.retryAfter)
      )
      res.setHeader(
        'X-Spam-Guard',
        resolved.header
      )
      res.setHeader(
        'X-Spam-Guard-Scope',
        safeScope
      )

      return res.status(429).json({
        ok: false,
        code: resolved.code,
        message: resolved.message,
        scope: safeScope,
        retry_after_seconds:
          resolved.retryAfter,
        cooldown_until:
          result.cooldown_until || null,
        quarantine_until:
          result.quarantine_until || null,
        block_status: resolved.status,
        offense_count: Number(
          result.offense_count || 0
        ),
        spam_score: Number(
          result.spam_score || 0
        ),
        reason:
          result.reason
          || 'Request limit exceeded',
      })
    } catch (error) {
      console.error('SPAM GUARD ERROR:', {
        scope: safeScope,
        path: requestPath,
        message: error?.message || error,
      })

      if (failOpen) return next()

      return res.status(503).json({
        ok: false,
        code: 'SPAM_GUARD_UNAVAILABLE',
        message:
          'Request protection is temporarily unavailable.',
      })
    }
  }
}
