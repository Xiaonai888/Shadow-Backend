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

function resolveBlockStatus(result) {
  const status = cleanText(result?.block_status, 80)

  if (status) return status
  if (result?.is_permanent_blocked) return 'permanent_block'
  if (result?.quarantine_until) return 'seven_day_quarantine'
  if (result?.cooldown_until) return 'temporary_cooldown'
  return 'allowed'
}

function buildBlockCode(blockStatus) {
  if (blockStatus === 'permanent_block') return 'PERMANENT_BLOCK'
  if (blockStatus === 'seven_day_quarantine') return 'SEVEN_DAY_QUARANTINE'
  return 'TEMPORARY_COOLDOWN'
}

function buildBlockMessage(blockStatus) {
  if (blockStatus === 'permanent_block') return 'This identity has been permanently blocked.'
  if (blockStatus === 'seven_day_quarantine') return 'This identity is quarantined for repeated spam.'
  return 'Too many requests. Please wait before trying again.'
}

function buildHeaderStatus(blockStatus) {
  if (blockStatus === 'permanent_block') return 'permanent-block'
  if (blockStatus === 'seven_day_quarantine') return 'seven-day-quarantine'
  return 'temporary-cooldown'
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

      const blockStatus = resolveBlockStatus(result)

      req.spamGuard = {
        scope: safeScope,
        guard_key: identity.guardKey,
        request_count: Number(result.request_count || 0),
        offense_count: Number(result.offense_count || 0),
        spam_score: Number(result.spam_score || 0),
        cooldown_until: result.cooldown_until || null,
        quarantine_until: result.quarantine_until || null,
        block_status: blockStatus,
        is_permanent_blocked: Boolean(result.is_permanent_blocked),
      }

      if (result.allowed !== false) return next()

      const retryAfter = Math.max(
        0,
        Number(result.retry_after_seconds || 0)
      )
      const statusCode = blockStatus === 'permanent_block' ? 403 : 429

      if (retryAfter > 0) res.setHeader('Retry-After', String(retryAfter))
      res.setHeader('X-Spam-Guard', buildHeaderStatus(blockStatus))
      res.setHeader('X-Spam-Guard-Scope', safeScope)

      return res.status(statusCode).json({
        ok: false,
        code: buildBlockCode(blockStatus),
        message: buildBlockMessage(blockStatus),
        scope: safeScope,
        block_status: blockStatus,
        retry_after_seconds: retryAfter,
        cooldown_until: result.cooldown_until || null,
        quarantine_until: result.quarantine_until || null,
        permanent_blocked_at: result.permanent_blocked_at || null,
        offense_count: Number(result.offense_count || 0),
        spam_score: Number(result.spam_score || 0),
        reason: result.reason || 'Request blocked by Spam Guard',
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
