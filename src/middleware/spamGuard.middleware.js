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

  // Use the last valid forwarded address. This is safer when the proxy
  // appends its observed client address to an existing header.
  return candidates.at(-1) || ''
}

function getClientIp(req) {
  return (
    getForwardedIp(req.headers['x-forwarded-for'])
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

function getVisitorId(req) {
  return cleanText(
    req.headers['x-shadow-visitor-id']
      || req.headers['x-visitor-id']
      || req.body?.visitor_id
      || req.query?.visitor_id,
    200
  )
}

function buildGuardIdentity(req) {
  const accountId = cleanText(req.user?.user_id, 200)
    || readBearerAccountId(req)
  const visitorId = getVisitorId(req)
  const ipAddress = getClientIp(req)

  /*
   * Identity priority:
   * 1. Logged-in account: stable and not shared between users.
   * 2. Anonymous IP: cannot be changed like a client-controlled visitor ID.
   * 3. Visitor ID: fallback only when the proxy did not provide an IP.
   *
   * Visitor ID is still stored as metadata for investigation.
   */
  const guardKey = accountId
    ? `account:${accountId}`
    : ipAddress
      ? `ip:${ipAddress}`
      : visitorId
        ? `visitor:${visitorId}`
        : ''

  return {
    guardKey,
    accountId,
    visitorId,
    ipAddress,
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

export function createSpamGuard({
  scope = 'global',
  threshold = 120,
  windowSeconds = 60,
  skipPaths = [],
  failOpen = true,
} = {}) {
  const safeScope = cleanText(scope, 80) || 'global'
  const safeThreshold = Math.max(1, Number(threshold) || 120)
  const safeWindowSeconds = Math.max(1, Number(windowSeconds) || 60)

  return async function spamGuardMiddleware(req, res, next) {
    if (req.method === 'OPTIONS') return next()

    const requestPath = cleanText(req.originalUrl || req.url || '/', 500)

    if (shouldSkipPath(requestPath, skipPaths)) return next()

    const identity = buildGuardIdentity(req)

    if (!identity.guardKey) return next()

    try {
      const { data, error } = await supabase.rpc('evaluate_spam_guard', {
        p_guard_key: identity.guardKey,
        p_scope: safeScope,
        p_ip_address: identity.ipAddress || null,
        p_visitor_id: identity.visitorId || null,
        p_account_id: identity.accountId || null,
        p_endpoint: requestPath,
        p_method: req.method,
        p_threshold: safeThreshold,
        p_window_seconds: safeWindowSeconds,
      })

      if (error) throw error

      const result = normalizeResult(data)

      if (!result) return next()

      req.spamGuard = {
        scope: safeScope,
        guard_key: identity.guardKey,
        request_count: Number(result.request_count || 0),
        offense_count: Number(result.offense_count || 0),
        spam_score: Number(result.spam_score || 0),
        cooldown_until: result.cooldown_until || null,
      }

      if (result.allowed !== false) return next()

      const retryAfter = Math.max(
        1,
        Number(result.retry_after_seconds || 60)
      )

      res.setHeader('Retry-After', String(retryAfter))
      res.setHeader('X-Spam-Guard', 'temporary-cooldown')
      res.setHeader('X-Spam-Guard-Scope', safeScope)

      return res.status(429).json({
        ok: false,
        code: 'TEMPORARY_COOLDOWN',
        message: 'Too many requests. Please wait before trying again.',
        scope: safeScope,
        retry_after_seconds: retryAfter,
        cooldown_until: result.cooldown_until || null,
        offense_count: Number(result.offense_count || 0),
        spam_score: Number(result.spam_score || 0),
        reason: result.reason || 'Request limit exceeded',
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
        message: 'Request protection is temporarily unavailable.',
      })
    }
  }
}
